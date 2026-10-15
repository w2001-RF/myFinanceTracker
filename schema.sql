-- Desired schema for myFinanceTracker (reflects the live database after
-- supabase/migrations/20261015000000_harden_schema.sql).
-- For an EXISTING database run the files in supabase/migrations/ instead; this file is for a fresh project.

begin;

create table if not exists public.general_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  description text not null,
  type text not null check (type in ('income', 'expense')),
  amount numeric not null check (amount > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.rental_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  income numeric not null check (income >= 0),
  expense numeric not null check (expense >= 0),
  expense_description text,
  created_at timestamptz not null default now(),
  constraint rental_records_user_month_key unique (user_id, month)
);

create table if not exists public.savings_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount numeric not null check (amount > 0),
  created_at timestamptz not null default now(),
  constraint savings_records_user_month_key unique (user_id, month)
);

create index if not exists general_transactions_user_month_idx
  on public.general_transactions (user_id, month);

alter table public.general_transactions enable row level security;
alter table public.rental_records       enable row level security;
alter table public.savings_records      enable row level security;

drop policy if exists "own rows" on public.general_transactions;
drop policy if exists "own rows" on public.rental_records;
drop policy if exists "own rows" on public.savings_records;

create policy "own rows" on public.general_transactions for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows" on public.rental_records for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows" on public.savings_records for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Quick (saved) transactions
create table if not exists public.transaction_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  description text not null check (length(trim(description)) > 0),
  type text not null check (type in ('income', 'expense')),
  amount numeric not null check (amount > 0),
  created_at timestamptz not null default now(),
  constraint transaction_templates_user_desc_type_key unique (user_id, description, type)
);

-- Per-user settings: loan to repay and main savings target
create table if not exists public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  loan_amount numeric not null default 70000 check (loan_amount > 0),
  savings_target numeric not null default 26000 check (savings_target > 0),
  updated_at timestamptz not null default now()
);

-- Savings sub-targets
create table if not exists public.savings_milestones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  amount numeric not null check (amount > 0),
  created_at timestamptz not null default now(),
  constraint savings_milestones_user_amount_key unique (user_id, amount)
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_settings_touch on public.user_settings;
create trigger user_settings_touch
  before update on public.user_settings
  for each row execute function public.touch_updated_at();

alter table public.transaction_templates enable row level security;
alter table public.user_settings         enable row level security;
alter table public.savings_milestones    enable row level security;

drop policy if exists "own rows" on public.transaction_templates;
drop policy if exists "own rows" on public.user_settings;
drop policy if exists "own rows" on public.savings_milestones;

create policy "own rows" on public.transaction_templates for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows" on public.user_settings for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows" on public.savings_milestones for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

commit;
