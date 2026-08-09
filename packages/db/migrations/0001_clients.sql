-- Bonolini OS — Customer Management (clients table)
--
-- Hand-authored (no Node/drizzle-kit in the environment that generated this
-- migration). Verify with `pnpm db:generate` once dependencies are
-- installed, and let drizzle-kit own migrations from here on.

create type customer_type as enum ('private', 'company');

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  profile_id uuid references profiles (id) on delete set null,
  customer_type customer_type not null default 'private',
  full_name text not null,
  company_name text,
  email text,
  phone text not null,
  country text,
  preferred_language text,
  notes text,
  marketing_consent boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists clients_tenant_id_idx on clients (tenant_id);
create index if not exists clients_deleted_at_idx on clients (deleted_at);
create index if not exists clients_full_name_idx on clients (lower(full_name));
create index if not exists clients_email_idx on clients (lower(email));
create index if not exists clients_phone_idx on clients (phone);

-- ── role-aware RLS ──────────────────────────────────────────────────────
-- docs/domain/09-roles-permissions.md flagged that Phase 0's RLS only
-- isolates by tenant, not by role, and that this is required before any
-- module with real staff-only data ships. This is that addition — and
-- auth_role() is reusable by every future module's policies, not just
-- clients.

create or replace function auth_role()
returns role
language sql
security definer
stable
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

alter table clients enable row level security;

-- Matches docs/domain/09-roles-permissions.md: admin + dispatcher can see
-- and manage all clients in their tenant; driver and client have no direct
-- table access yet (no driver/client-facing UI reads this table today).

create policy "staff can view clients in their tenant"
  on clients for select
  using (tenant_id = auth_tenant_id() and auth_role() in ('admin', 'dispatcher'));

create policy "staff can insert clients in their tenant"
  on clients for insert
  with check (tenant_id = auth_tenant_id() and auth_role() in ('admin', 'dispatcher'));

create policy "staff can update clients in their tenant"
  on clients for update
  using (tenant_id = auth_tenant_id() and auth_role() in ('admin', 'dispatcher'));

-- No delete policy: clients are soft-deleted (update deleted_at), never
-- hard-deleted, so the update policy above already covers it.
