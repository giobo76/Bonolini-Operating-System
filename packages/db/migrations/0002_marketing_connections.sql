-- Bonolini OS — Marketing Intelligence Engine, MIE-1 (OAuth connection foundation)
--
-- Hand-authored (no Node/drizzle-kit available). Verify with `pnpm db:generate`
-- once dependencies are installed.
--
-- Scope: connection + linked-resource bookkeeping only. No findings/reports/
-- check_runs tables yet — those arrive in MIE-2/3 once the engine actually
-- reads and analyzes Google Ads/GA4/GTM/Search Console data. See
-- packages/core/src/marketing/README.md for what's implemented vs planned.

create type marketing_connection_status as enum ('active', 'needs_reauth', 'revoked');
create type marketing_resource_type as enum ('google_ads_account', 'ga4_property', 'gtm_container', 'search_console_site');

create table if not exists marketing_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  encrypted_refresh_token text not null,
  granted_scopes text[] not null,
  connected_by uuid references profiles (id) on delete set null,
  connected_at timestamptz not null default now(),
  status marketing_connection_status not null default 'active',
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id)
);

create table if not exists marketing_linked_resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  connection_id uuid not null references marketing_connections (id) on delete cascade,
  resource_type marketing_resource_type not null,
  external_id text not null,
  display_name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_linked_resources_tenant_id_idx on marketing_linked_resources (tenant_id);
create index if not exists marketing_linked_resources_connection_id_idx on marketing_linked_resources (connection_id);

-- ── admin-only RLS ──────────────────────────────────────────────────────
-- Stricter than clients (docs/domain/09-roles-permissions.md scopes ad
-- spend / marketing strategy data to admin only, not dispatcher). Reuses
-- auth_tenant_id() and auth_role() from earlier migrations.

alter table marketing_connections enable row level security;
alter table marketing_linked_resources enable row level security;

create policy "admin can view marketing connection in their tenant"
  on marketing_connections for select
  using (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can insert marketing connection in their tenant"
  on marketing_connections for insert
  with check (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can update marketing connection in their tenant"
  on marketing_connections for update
  using (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can view linked resources in their tenant"
  on marketing_linked_resources for select
  using (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can insert linked resources in their tenant"
  on marketing_linked_resources for insert
  with check (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can delete linked resources in their tenant"
  on marketing_linked_resources for delete
  using (tenant_id = auth_tenant_id() and auth_role() = 'admin');
