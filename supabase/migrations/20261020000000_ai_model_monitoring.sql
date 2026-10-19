-- Migration: AI model settings, backup model, and monitoring (health, latency, tokens).
-- Run once in the Supabase SQL editor (after 20261017000000_admin_console.sql and 20261019000000_ai_monthly_cache.sql).
-- Re-runnable.
--
-- Privacy: the monitoring tables hold technical metrics only (model name, status, latency, token counts).
-- They never contain prompts, summaries, advice text or user ids, and they are readable by admins only.

begin;

-- 1. Editable settings for the advice models (single row). Only admins can read or change them.
--    The provider base URL and API key stay in Edge Function secrets on purpose: an editable URL could
--    redirect users' summaries to an arbitrary host.
create table if not exists public.ai_model_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default true,
  primary_model text not null default 'llama-3.3-70b-versatile'
    check (primary_model ~ '^[A-Za-z0-9._:/-]{1,80}$'),
  fallback_model text not null default 'llama-3.1-8b-instant'
    check (fallback_model ~ '^[A-Za-z0-9._:/-]{1,80}$'),
  temperature numeric not null default 0.4 check (temperature between 0 and 1.5),
  max_tokens integer not null default 600 check (max_tokens between 100 and 2000),
  timeout_seconds integer not null default 20 check (timeout_seconds between 5 and 60),
  max_users_per_run integer not null default 20 check (max_users_per_run between 1 and 100),
  delay_ms integer not null default 2500 check (delay_ms between 0 and 30000),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.ai_model_settings (id) values (true) on conflict (id) do nothing;

alter table public.ai_model_settings enable row level security;
drop policy if exists "admins read ai settings" on public.ai_model_settings;
drop policy if exists "admins update ai settings" on public.ai_model_settings;
create policy "admins read ai settings" on public.ai_model_settings for select to authenticated
  using ((select public.is_admin()));
create policy "admins update ai settings" on public.ai_model_settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
revoke all on public.ai_model_settings from anon;
revoke insert, delete on public.ai_model_settings from authenticated;

create or replace function public.ai_model_settings_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- Same audit trail as the other app settings
create or replace function public.ai_model_settings_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed text[];
begin
  select coalesce(array_agg(key order by key), '{}')
    into changed
    from jsonb_each(to_jsonb(new)) n
    join jsonb_each(to_jsonb(old)) o using (key)
   where n.value is distinct from o.value
     and key not in ('updated_at', 'updated_by');

  if array_length(changed, 1) is not null then
    insert into public.admin_audit_log (admin_id, action, details)
    values (auth.uid(), 'update_ai_model_settings', jsonb_build_object('changed', to_jsonb(changed)));
  end if;
  return new;
end;
$$;

drop trigger if exists ai_model_settings_before_update on public.ai_model_settings;
create trigger ai_model_settings_before_update
  before update on public.ai_model_settings
  for each row execute function public.ai_model_settings_before_update();

drop trigger if exists ai_model_settings_audit on public.ai_model_settings;
create trigger ai_model_settings_audit
  after update on public.ai_model_settings
  for each row execute function public.ai_model_settings_audit();

-- 2. One row per cron run
create table if not exists public.ai_advice_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  period text,
  status text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed', 'disabled')),
  processed integer not null default 0,
  skipped_invalid integer not null default 0,
  failed integer not null default 0,
  remaining integer not null default 0,
  stopped_early boolean not null default false,
  duration_ms integer
);

-- 3. One row per model call (advice generation, or an admin health test)
create table if not exists public.ai_advice_calls (
  id bigint generated always as identity primary key,
  run_id bigint references public.ai_advice_runs(id) on delete set null,
  kind text not null default 'advice' check (kind in ('advice', 'health')),
  model text not null,
  role text not null check (role in ('primary', 'fallback')),
  ok boolean not null,
  http_status integer,
  error_kind text check (error_kind is null or error_kind in
    ('timeout', 'network', 'rate_limited', 'auth', 'model_unavailable', 'server_error', 'bad_request', 'bad_response')),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  prompt_tokens integer check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens is null or completion_tokens >= 0),
  total_tokens integer check (total_tokens is null or total_tokens >= 0),
  created_at timestamptz not null default now()
);

create index if not exists ai_advice_calls_created_idx on public.ai_advice_calls (created_at desc);
create index if not exists ai_advice_calls_kind_created_idx on public.ai_advice_calls (kind, created_at desc);
create index if not exists ai_advice_runs_started_idx on public.ai_advice_runs (started_at desc);

alter table public.ai_advice_runs enable row level security;
alter table public.ai_advice_calls enable row level security;
drop policy if exists "admins read ai runs" on public.ai_advice_runs;
drop policy if exists "admins read ai calls" on public.ai_advice_calls;
create policy "admins read ai runs" on public.ai_advice_runs for select to authenticated
  using ((select public.is_admin()));
create policy "admins read ai calls" on public.ai_advice_calls for select to authenticated
  using ((select public.is_admin()));
-- Only the Edge Functions (service role) write metrics
revoke all on public.ai_advice_runs from anon;
revoke all on public.ai_advice_calls from anon;
revoke insert, update, delete on public.ai_advice_runs from authenticated;
revoke insert, update, delete on public.ai_advice_calls from authenticated;

-- 4. Aggregated metrics for the admin dashboard (counts, latencies and tokens only)
create or replace function public.ai_advice_metrics(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d integer := least(greatest(coalesce(p_days, 30), 1), 365);
  since timestamptz := now() - make_interval(days => d);
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'days', d,
    'totals', (
      select jsonb_build_object(
        'calls', count(*),
        'ok_calls', count(*) filter (where ok),
        'fallback_calls', count(*) filter (where role = 'fallback'),
        'prompt_tokens', coalesce(sum(prompt_tokens), 0),
        'completion_tokens', coalesce(sum(completion_tokens), 0),
        'total_tokens', coalesce(sum(total_tokens), 0),
        'avg_latency_ms', coalesce(round(avg(latency_ms))::integer, 0)
      )
      from public.ai_advice_calls
      where kind = 'advice' and created_at >= since
    ),
    'by_model', coalesce((
      select jsonb_agg(m order by m.calls desc)
      from (
        select model,
               count(*) as calls,
               count(*) filter (where ok) as ok_calls,
               count(*) filter (where not ok) as error_calls,
               count(*) filter (where role = 'fallback') as fallback_calls,
               coalesce(round(avg(latency_ms))::integer, 0) as avg_latency_ms,
               coalesce(round(percentile_cont(0.95) within group (order by latency_ms))::integer, 0) as p95_latency_ms,
               coalesce(sum(prompt_tokens), 0) as prompt_tokens,
               coalesce(sum(completion_tokens), 0) as completion_tokens,
               coalesce(sum(total_tokens), 0) as total_tokens
          from public.ai_advice_calls
         where kind = 'advice' and created_at >= since
         group by model
      ) m
    ), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(x order by x.day desc)
      from (
        select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
               count(*) as calls,
               count(*) filter (where ok) as ok_calls,
               coalesce(sum(total_tokens), 0) as total_tokens
          from public.ai_advice_calls
         where kind = 'advice' and created_at >= greatest(since, now() - interval '14 days')
         group by 1
      ) x
    ), '[]'::jsonb),
    'recent_errors', coalesce((
      select jsonb_agg(e order by e.created_at desc)
      from (
        select created_at, kind, model, role, http_status, error_kind, latency_ms
          from public.ai_advice_calls
         where not ok
         order by created_at desc
         limit 10
      ) e
    ), '[]'::jsonb),
    'last_run', (
      select to_jsonb(r)
      from (
        select started_at, finished_at, period, status, processed, skipped_invalid, failed, remaining, stopped_early, duration_ms
          from public.ai_advice_runs
         order by started_at desc
         limit 1
      ) r
    ),
    'last_health', coalesce((
      select jsonb_agg(h order by h.role)
      from (
        select distinct on (model, role) created_at, model, role, ok, http_status, error_kind, latency_ms,
               prompt_tokens, completion_tokens, total_tokens
          from public.ai_advice_calls
         where kind = 'health'
         order by model, role, created_at desc
      ) h
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.ai_advice_metrics(integer) from public, anon;
grant execute on function public.ai_advice_metrics(integer) to authenticated;

commit;
