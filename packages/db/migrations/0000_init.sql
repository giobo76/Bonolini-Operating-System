-- Bonolini OS — initial schema (Phase 0 foundation)
--
-- Hand-authored baseline (no Node/drizzle-kit available in the environment
-- that generated this repo). Once `pnpm install` has run, verify this
-- against `pnpm db:generate` before treating it as authoritative, and let
-- drizzle-kit own all migrations from here on.
--
-- Scope: multi-tenant + auth foundation only. Domain tables (bookings,
-- drivers, clients, billing, notifications) are added in Phase 1 migrations.

create extension if not exists "pgcrypto";

-- ── tenants ──────────────────────────────────────────────────────────────

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

-- The only tenant that exists today. Adding the AI Automation Agency later
-- (docs/future-agency.md) means inserting a second row here, not a migration.
insert into tenants (slug, name)
values ('bonolini-transfer', 'Bonolini Transfer')
on conflict (slug) do nothing;

-- ── profiles ─────────────────────────────────────────────────────────────
-- One row per Supabase Auth user, extending auth.users with tenant + role.

create type role as enum ('admin', 'dispatcher', 'driver', 'client');

create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  tenant_id uuid not null references tenants (id) on delete cascade,
  role role not null default 'client',
  full_name text,
  created_at timestamptz not null default now()
);

-- ── row level security ──────────────────────────────────────────────────
-- Enforced in the database, not just the app layer (ADR 0003).
--
-- auth_tenant_id() is `security definer` so it can read the caller's own
-- profile row to resolve their tenant_id without triggering RLS recursion
-- (a policy on `profiles` must not itself query `profiles` under RLS).

create or replace function auth_tenant_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select tenant_id from profiles where id = auth.uid();
$$;

alter table tenants enable row level security;
alter table profiles enable row level security;

create policy "tenants are visible to their members"
  on tenants for select
  using (id = auth_tenant_id());

create policy "profiles are visible within own tenant"
  on profiles for select
  using (tenant_id = auth_tenant_id());

create policy "users can update their own profile"
  on profiles for update
  using (id = auth.uid());

-- ── new-user provisioning ───────────────────────────────────────────────
-- Every new Supabase Auth signup gets a profile row, defaulted into the
-- single seeded tenant with the lowest-privilege role. Promoting someone to
-- admin/dispatcher/driver is a manual step (Supabase dashboard or a direct
-- SQL update) until an invite/role-management flow exists — that is
-- explicitly out of scope for Phase 0.

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, tenant_id, role, full_name)
  values (
    new.id,
    (select id from public.tenants where slug = 'bonolini-transfer'),
    'client',
    new.raw_user_meta_data ->> 'full_name'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
