-- Migration: per-user usage counter for the ai-advice Edge Function (daily quota).
-- Stores only a timestamp per request: no financial data and no AI output is ever saved.
-- Run once in the Supabase SQL editor. Re-runnable.

begin;

create table if not exists public.ai_advice_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists ai_advice_usage_user_created_idx
  on public.ai_advice_usage (user_id, created_at desc);

alter table public.ai_advice_usage enable row level security;

drop policy if exists "read own usage" on public.ai_advice_usage;
drop policy if exists "insert own usage" on public.ai_advice_usage;
create policy "read own usage" on public.ai_advice_usage for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "insert own usage" on public.ai_advice_usage for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- Users cannot edit or delete usage rows (otherwise they could reset their own quota)
revoke update, delete on public.ai_advice_usage from anon, authenticated;

commit;
