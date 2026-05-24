-- Migration GesFin v3 : nouvelles catégories + objectifs d'épargne
-- Exécuter dans Supabase SQL Editor

-- Étendre les catégories autorisées
alter table public.transactions drop constraint if exists transactions_category_check;
alter table public.transactions add constraint transactions_category_check
  check (category in (
    'nourriture', 'transport', 'loyer', 'télécom', 'santé',
    'salaire', 'business', 'autre'
  ));

-- Table objectifs d'épargne mensuels
create table if not exists public.savings_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  month_key text not null,
  amount bigint not null default 0 check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, month_key)
);

alter table public.savings_goals enable row level security;

drop policy if exists "savings_goals_select_own" on public.savings_goals;
drop policy if exists "savings_goals_insert_own" on public.savings_goals;
drop policy if exists "savings_goals_update_own" on public.savings_goals;
drop policy if exists "savings_goals_delete_own" on public.savings_goals;

create policy "savings_goals_select_own"
on public.savings_goals for select
using (auth.uid() = user_id);

create policy "savings_goals_insert_own"
on public.savings_goals for insert
with check (auth.uid() = user_id);

create policy "savings_goals_update_own"
on public.savings_goals for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "savings_goals_delete_own"
on public.savings_goals for delete
using (auth.uid() = user_id);
