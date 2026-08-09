-- Bonolini OS — Marketing Intelligence Engine: weekly executive reports
--
-- Hand-authored (no Node/drizzle-kit available). Verify with `pnpm db:generate`
-- once dependencies are installed.

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  content text not null,
  generated_at timestamptz not null default now(),
  emailed_at timestamptz
);

create index if not exists reports_tenant_id_idx on reports (tenant_id);
create index if not exists reports_generated_at_idx on reports (generated_at desc);

alter table reports enable row level security;

create policy "admin can view reports in their tenant"
  on reports for select
  using (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can insert reports in their tenant"
  on reports for insert
  with check (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can update reports in their tenant"
  on reports for update
  using (tenant_id = auth_tenant_id() and auth_role() = 'admin');
