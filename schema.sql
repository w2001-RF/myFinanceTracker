-- Run in the Supabase SQL editor. Idempotent where possible.
-- Adjust column types if your existing tables differ.

create table if not exists public.general_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  month text not null,
  description text not null,
  type text not null check (type in ('income', 'expense')),
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.rental_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  month text not null,
  income numeric(12,2) not null default 0 check (income >= 0),
  expense numeric(12,2) not null default 0 check (expense >= 0),
  expense_description text,
  created_at timestamptz not null default now(),
  unique (user_id, month)
);

create table if not exists public.savings_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  month text not null,
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (user_id, month)
);

-- If the tables already exist, add the unique constraints the app's upsert needs
-- (remove duplicate rows first):
--   alter table public.rental_records add constraint rental_records_user_month_key unique (user_id, month);
--   alter table public.savings_records add constraint savings_records_user_month_key unique (user_id, month);

-- Row Level Security: users can only touch their own rows
alter table public.general_transactions enable row level security;
alter table public.rental_records enable row level security;
alter table public.savings_records enable row level security;

do $$
declare t text;
begin
  foreach t in array array['general_transactions', 'rental_records', 'savings_records'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated
         using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
  end loop;
end $$;
