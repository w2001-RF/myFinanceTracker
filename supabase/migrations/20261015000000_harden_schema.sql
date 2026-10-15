-- Migration: harden schema (based on the live database inspected on 2026-10-15)
-- Safe to run once in the Supabase SQL editor; it is also re-runnable.
-- Runs in a single transaction: if anything fails, nothing is changed.

begin;

-- 0. Pre-flight: abort with a clear message if existing data would violate the new rules
do $$
begin
  if exists (select 1 from public.rental_records  group by user_id, month having count(*) > 1)
  or exists (select 1 from public.savings_records group by user_id, month having count(*) > 1) then
    raise exception 'Duplicate (user_id, month) rows exist in rental_records or savings_records; resolve them first';
  end if;

  if exists (select 1 from public.general_transactions where amount <= 0 or type not in ('income','expense'))
  or exists (select 1 from public.rental_records  where income < 0 or expense < 0)
  or exists (select 1 from public.savings_records where amount <= 0) then
    raise exception 'Rows violate the new check constraints (amount/type); fix them first';
  end if;

  if exists (select 1 from public.general_transactions where month !~ '^\d{4}-(0[1-9]|1[0-2])$')
  or exists (select 1 from public.rental_records  where month !~ '^\d{4}-(0[1-9]|1[0-2])$')
  or exists (select 1 from public.savings_records where month !~ '^\d{4}-(0[1-9]|1[0-2])$') then
    raise exception 'Some month values are not in YYYY-MM format; fix them first';
  end if;
end $$;

-- 1. user_id defaults to the caller
alter table public.general_transactions alter column user_id set default auth.uid();
alter table public.rental_records       alter column user_id set default auth.uid();
alter table public.savings_records      alter column user_id set default auth.uid();

-- 2. Foreign keys: delete a user's data when the auth user is deleted
alter table public.general_transactions drop constraint if exists general_transactions_user_id_fkey;
alter table public.general_transactions add  constraint general_transactions_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.rental_records drop constraint if exists rental_records_user_id_fkey;
alter table public.rental_records add  constraint rental_records_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.savings_records drop constraint if exists savings_records_user_id_fkey;
alter table public.savings_records add  constraint savings_records_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- 3. One row per user per month (required by the app's upsert on user_id,month)
alter table public.rental_records  drop constraint if exists rental_records_user_month_key;
alter table public.rental_records  add  constraint rental_records_user_month_key  unique (user_id, month);

alter table public.savings_records drop constraint if exists savings_records_user_month_key;
alter table public.savings_records add  constraint savings_records_user_month_key unique (user_id, month);

-- 4. Data validation
alter table public.general_transactions drop constraint if exists general_transactions_type_check;
alter table public.general_transactions add  constraint general_transactions_type_check   check (type in ('income', 'expense'));
alter table public.general_transactions drop constraint if exists general_transactions_amount_check;
alter table public.general_transactions add  constraint general_transactions_amount_check check (amount > 0);
alter table public.general_transactions drop constraint if exists general_transactions_month_check;
alter table public.general_transactions add  constraint general_transactions_month_check  check (month ~ '^\d{4}-(0[1-9]|1[0-2])$');

alter table public.rental_records drop constraint if exists rental_records_income_check;
alter table public.rental_records add  constraint rental_records_income_check  check (income >= 0);
alter table public.rental_records drop constraint if exists rental_records_expense_check;
alter table public.rental_records add  constraint rental_records_expense_check check (expense >= 0);
alter table public.rental_records drop constraint if exists rental_records_month_check;
alter table public.rental_records add  constraint rental_records_month_check   check (month ~ '^\d{4}-(0[1-9]|1[0-2])$');

alter table public.savings_records drop constraint if exists savings_records_amount_check;
alter table public.savings_records add  constraint savings_records_amount_check check (amount > 0);
alter table public.savings_records drop constraint if exists savings_records_month_check;
alter table public.savings_records add  constraint savings_records_month_check  check (month ~ '^\d{4}-(0[1-9]|1[0-2])$');

-- 5. created_at: timestamptz and never null (existing values were stored as UTC by now())
update public.general_transactions set created_at = now() where created_at is null;
update public.rental_records       set created_at = now() where created_at is null;
update public.savings_records      set created_at = now() where created_at is null;

alter table public.general_transactions alter column created_at type timestamptz using created_at at time zone 'UTC';
alter table public.rental_records       alter column created_at type timestamptz using created_at at time zone 'UTC';
alter table public.savings_records      alter column created_at type timestamptz using created_at at time zone 'UTC';

alter table public.general_transactions alter column created_at set not null;
alter table public.rental_records       alter column created_at set not null;
alter table public.savings_records      alter column created_at set not null;

-- 6. Index for the app's per-user, month-ordered query on transactions
--    (rental/savings are already covered by their unique indexes)
create index if not exists general_transactions_user_month_idx
  on public.general_transactions (user_id, month);

-- 7. RLS: already enabled. Replace the {public}-role policies with authenticated-only ones.
alter table public.general_transactions enable row level security;
alter table public.rental_records       enable row level security;
alter table public.savings_records      enable row level security;

drop policy if exists "Users can view own transactions"      on public.general_transactions;
drop policy if exists "Users can insert own transactions"    on public.general_transactions;
drop policy if exists "Users can update own transactions"    on public.general_transactions;
drop policy if exists "Users can delete own transactions"    on public.general_transactions;
drop policy if exists "Users can view own rental records"    on public.rental_records;
drop policy if exists "Users can insert own rental records"  on public.rental_records;
drop policy if exists "Users can update own rental records"  on public.rental_records;
drop policy if exists "Users can delete own rental records"  on public.rental_records;
drop policy if exists "Users can view own savings records"   on public.savings_records;
drop policy if exists "Users can insert own savings records" on public.savings_records;
drop policy if exists "Users can update own savings records" on public.savings_records;
drop policy if exists "Users can delete own savings records" on public.savings_records;
drop policy if exists "own rows" on public.general_transactions;
drop policy if exists "own rows" on public.rental_records;
drop policy if exists "own rows" on public.savings_records;

-- (select auth.uid()) is evaluated once per query instead of once per row
create policy "own rows" on public.general_transactions for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows" on public.rental_records for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows" on public.savings_records for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

commit;
