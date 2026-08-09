-- Bonolini OS — Marketing Intelligence Engine: findings, Health Score, check runs
--
-- Hand-authored (no Node/drizzle-kit available). Verify with `pnpm db:generate`
-- once dependencies are installed.
--
-- Built ahead of MIE-2's actual detection logic, at the founder's explicit
-- request: the engine must "think like a CMO" — every finding carries
-- severity, confidence, business impact, estimated financial impact, root
-- cause, recommended actions, an approval flag, and expected benefit — and
-- the system tracks a 0-100 Marketing Health Score over time, with a clear
-- split between technical issues (active harm) and strategic opportunities
-- (unrealized upside). See packages/core/src/marketing/health-score.ts for
-- how the score is computed. Nothing writes to these tables yet.

create type check_run_type as enum ('quick_check', 'daily_audit', 'weekly_report', 'on_demand');
create type check_run_status as enum ('running', 'completed', 'failed');

create table if not exists check_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  run_type check_run_type not null,
  status check_run_status not null default 'running',
  triggered_by uuid references profiles (id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  summary text,
  error_message text
);

create index if not exists check_runs_tenant_id_idx on check_runs (tenant_id);
create index if not exists check_runs_started_at_idx on check_runs (started_at desc);

create type finding_category as enum (
  'conversion_tracking', 'duplicate_conversions', 'attribution', 'gtm_configuration',
  'budget_pacing', 'budget_waste', 'bid_cpc_anomaly', 'quality_score', 'impression_share',
  'policy_compliance', 'account_health', 'landing_page_availability', 'page_speed',
  'core_web_vitals', 'search_console_indexing', 'organic_traffic', 'form_tracking',
  'call_tracking', 'whatsapp_tracking', 'competitor_observation', 'other'
);

create type finding_nature as enum ('technical_issue', 'strategic_opportunity');
create type finding_severity as enum ('critical', 'high', 'medium', 'low');
create type finding_status as enum ('open', 'acknowledged', 'resolved', 'dismissed');

create table if not exists findings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  check_run_id uuid references check_runs (id) on delete set null,
  category finding_category not null,
  nature finding_nature not null,
  severity finding_severity not null,
  confidence_score smallint not null check (confidence_score between 0 and 100),
  title text not null,
  observation text not null,
  root_cause text,
  business_impact text not null,
  financial_impact jsonb,
  recommended_actions jsonb not null default '[]'::jsonb,
  requires_approval boolean not null default false,
  expected_benefit text,
  evidence jsonb,
  status finding_status not null default 'open',
  first_detected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists findings_tenant_id_idx on findings (tenant_id);
create index if not exists findings_status_idx on findings (status);
create index if not exists findings_severity_idx on findings (severity);
create index if not exists findings_nature_idx on findings (nature);
create index if not exists findings_check_run_id_idx on findings (check_run_id);

create table if not exists marketing_health_scores (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  check_run_id uuid references check_runs (id) on delete set null,
  overall_score smallint not null check (overall_score between 0 and 100),
  breakdown jsonb not null,
  opportunity_value jsonb,
  summary text,
  computed_at timestamptz not null default now()
);

create index if not exists marketing_health_scores_tenant_computed_idx
  on marketing_health_scores (tenant_id, computed_at desc);

-- ── admin-only RLS (same pattern as 0002) ───────────────────────────────

alter table check_runs enable row level security;
alter table findings enable row level security;
alter table marketing_health_scores enable row level security;

create policy "admin can view check runs in their tenant"
  on check_runs for select
  using (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can insert check runs in their tenant"
  on check_runs for insert
  with check (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can update check runs in their tenant"
  on check_runs for update
  using (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can view findings in their tenant"
  on findings for select
  using (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can insert findings in their tenant"
  on findings for insert
  with check (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can update findings in their tenant"
  on findings for update
  using (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can view health scores in their tenant"
  on marketing_health_scores for select
  using (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can insert health scores in their tenant"
  on marketing_health_scores for insert
  with check (tenant_id = auth_tenant_id() and auth_role() = 'admin');
