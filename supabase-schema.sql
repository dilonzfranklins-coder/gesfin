-- Exécuter ce script dans Supabase SQL Editor

create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (name in ('Wave', 'Orange Money', 'Cash', 'Banque')),
  balance bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  wallet text not null check (wallet in ('Wave', 'Orange Money', 'Cash', 'Banque')),
  amount bigint not null check (amount > 0),
  type text not null check (type in ('revenu', 'dépense')),
  category text not null check (category in ('nourriture', 'transport', 'loyer', 'télécom', 'santé')),
  created_at timestamptz not null default now()
);

alter table public.wallets enable row level security;
alter table public.transactions enable row level security;

drop policy if exists "wallets_select_own" on public.wallets;
drop policy if exists "wallets_insert_own" on public.wallets;
drop policy if exists "wallets_update_own" on public.wallets;
drop policy if exists "wallets_delete_own" on public.wallets;

create policy "wallets_select_own"
on public.wallets for select
using (auth.uid() = user_id);

create policy "wallets_insert_own"
on public.wallets for insert
with check (auth.uid() = user_id);

create policy "wallets_update_own"
on public.wallets for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "wallets_delete_own"
on public.wallets for delete
using (auth.uid() = user_id);

drop policy if exists "transactions_select_own" on public.transactions;
drop policy if exists "transactions_insert_own" on public.transactions;
drop policy if exists "transactions_update_own" on public.transactions;
drop policy if exists "transactions_delete_own" on public.transactions;

create policy "transactions_select_own"
on public.transactions for select
using (auth.uid() = user_id);

create policy "transactions_insert_own"
on public.transactions for insert
with check (auth.uid() = user_id);

create policy "transactions_update_own"
on public.transactions for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "transactions_delete_own"
on public.transactions for delete
using (auth.uid() = user_id);
