-- Migration: owner/admin console.
-- The admin can manage APP-WIDE settings only. No policy or function in this migration
-- gives an admin access to other users' financial data (general_transactions, rental_records,
-- savings_records, transaction_templates, user_settings, savings_milestones stay "own rows only").
-- Run once in the Supabase SQL editor. Re-runnable.

begin;

-- 1. Who is an admin. Rows can only be created/removed with the SQL editor / service role
--    (no INSERT/UPDATE/DELETE policy and the privileges are revoked), never from the app.
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.app_admins enable row level security;
drop policy if exists "see own admin row" on public.app_admins;
create policy "see own admin row" on public.app_admins for select to authenticated
  using ((select auth.uid()) = user_id);
revoke insert, update, delete on public.app_admins from anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_admins where user_id = (select auth.uid()));
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- 2. App-wide settings (single row). Non-sensitive, so everyone can read them
--    (the login screen needs the announcement / sign-up flag); only admins can change them.
create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  maintenance_mode boolean not null default false,
  maintenance_message text not null default '' check (length(maintenance_message) <= 300),
  announcement text not null default '' check (length(announcement) <= 300),
  signups_enabled boolean not null default true,
  default_loan_amount numeric not null default 70000 check (default_loan_amount > 0),
  default_savings_target numeric not null default 26000 check (default_savings_target > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.app_settings (id) values (true) on conflict (id) do nothing;

alter table public.app_settings enable row level security;
drop policy if exists "read app settings" on public.app_settings;
drop policy if exists "admins update app settings" on public.app_settings;
create policy "read app settings" on public.app_settings for select to anon, authenticated
  using (true);
create policy "admins update app settings" on public.app_settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
revoke insert, delete on public.app_settings from anon, authenticated;
revoke update on public.app_settings from anon;

-- 3. Audit log of admin actions (readable by admins only, written only by the trigger below)
create table if not exists public.admin_audit_log (
  id bigint generated always as identity primary key,
  admin_id uuid references auth.users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_audit_log enable row level security;
drop policy if exists "admins read audit log" on public.admin_audit_log;
create policy "admins read audit log" on public.admin_audit_log for select to authenticated
  using ((select public.is_admin()));
revoke insert, update, delete on public.admin_audit_log from anon, authenticated;
revoke select on public.admin_audit_log from anon;

create or replace function public.app_settings_before_update()
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

create or replace function public.app_settings_audit()
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
    values (auth.uid(), 'update_app_settings', jsonb_build_object('changed', to_jsonb(changed)));
  end if;
  return new;
end;
$$;

drop trigger if exists app_settings_before_update on public.app_settings;
create trigger app_settings_before_update
  before update on public.app_settings
  for each row execute function public.app_settings_before_update();

drop trigger if exists app_settings_audit on public.app_settings;
create trigger app_settings_audit
  after update on public.app_settings
  for each row execute function public.app_settings_audit();

-- 4. Aggregate-only overview for the owner: counts, never emails, identities or content.
create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'total_accounts', (select count(*) from auth.users),
    'new_accounts_30d', (select count(*) from auth.users where created_at > now() - interval '30 days')
  );
end;
$$;

revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;

commit;

-- 5. Make yourself the owner (run ONCE, after replacing the email). Not part of the migration
--    so that no admin is ever created by accident:
--
--   insert into public.app_admins (user_id)
--   select id from auth.users where email = 'owner@example.com';
