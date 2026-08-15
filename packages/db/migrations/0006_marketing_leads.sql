-- Bonolini OS — Marketing Intelligence Engine: anonymous lead intent capture
--
-- Hand-authored (no Node/drizzle-kit available). Verify with `pnpm db:generate`
-- once dependencies are installed.
--
-- Context: bonolinitransfer.com's real conversion funnel is WhatsApp/phone/
-- email click-to-contact, not a web form — see packages/core/src/marketing/
-- README.md and the funnel design audit. A click carries no name/phone/email
-- (that conversation happens entirely off-site), so it cannot be represented
-- as a `clients` row (full_name/phone are NOT NULL there, and doing so would
-- mean placeholder data — explicitly ruled out). This table exists to hold
-- that anonymous-but-attributed signal until a human (the founder) links it
-- to a real `clients` row once the conversation produces one. Deliberately
-- kept separate from `clients` per ADR 0002's module-boundary principle: this
-- is a marketing-domain fact (top-of-funnel intent), not a customer record.

create type marketing_lead_channel as enum ('whatsapp', 'phone', 'email', 'form');
create type marketing_lead_status as enum ('new', 'contacted', 'converted', 'discarded');

create table if not exists marketing_leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  channel marketing_lead_channel not null,
  status marketing_lead_status not null default 'new',
  -- Set only when a staff member manually links this intent to a real
  -- client (see linkLeadToClient) — never during public creation. No
  -- automatic name/phone matching: at click time neither is known.
  client_id uuid references clients (id) on delete set null,
  landing_page text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  gclid text,
  -- First-party, browser-generated id (not a cross-site cookie) used only to
  -- group multiple intents from the same visitor before conversion — see
  -- the funnel design audit.
  visitor_id text,
  created_at timestamptz not null default now()
);

create index if not exists marketing_leads_tenant_id_idx on marketing_leads (tenant_id);
create index if not exists marketing_leads_client_id_idx on marketing_leads (client_id);
create index if not exists marketing_leads_status_idx on marketing_leads (status);
create index if not exists marketing_leads_created_at_idx on marketing_leads (created_at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Staff/admin read+update (marketing data, same tier as findings/health
-- scores — dispatchers don't need this, unlike quotes/bookings). Insert is
-- intentionally public: the lead-intent endpoint (Phase 3) writes here
-- unauthenticated, from bonolinitransfer.com. Same caveat already recorded
-- in 0004_funnel_attribution.sql applies: this app's DATABASE_URL connects
-- as the `postgres` role (BYPASSRLS), so the real enforcement boundary is
-- the endpoint/service layer, not this policy — kept for defense-in-depth
-- and correctness if the connection model ever changes.

alter table marketing_leads enable row level security;

create policy "admin can view marketing leads in their tenant"
  on marketing_leads for select
  using (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "admin can update marketing leads in their tenant"
  on marketing_leads for update
  using (tenant_id = auth_tenant_id() and auth_role() = 'admin');

create policy "anyone can record a lead intent"
  on marketing_leads for insert
  with check (true);
