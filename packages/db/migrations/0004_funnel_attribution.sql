-- Bonolini OS — Marketing funnel attribution: Click → Lead → Quote →
-- Deposit → Confirmed booking → Completed service → Invoice → Payment
--
-- Hand-authored (no Node/drizzle-kit available). Verify with `pnpm db:generate`
-- once dependencies are installed.
--
-- Context: the Marketing Intelligence Engine was asked to connect ad
-- performance to real business outcomes, not just advertising metrics. Only
-- "Lead" (clients) existed as real data — Quote, Booking, Invoice, and
-- Payment did not exist anywhere in the codebase. Rather than fabricate
-- attribution tables under the marketing module, this migration adds:
--   1. First-touch attribution fields on clients (captured once at lead
--      creation; every downstream entity attributes via client_id, not by
--      duplicating UTM data on every table).
--   2. Minimal, real quotes and bookings tables — status + money + client
--      link only, no dispatch/driver/calendar logic. These are the actual
--      foundation of the future Pricing & Quotes and Booking Management
--      features, not throwaway tables built just for attribution.
-- Invoice/payment are flattened onto bookings for now rather than separate
-- tables — enough for funnel attribution without building the full
-- Invoicing/Payments features ahead of their turn on the roadmap.

-- ── clients: attribution fields ─────────────────────────────────────────

alter table clients add column if not exists utm_source text;
alter table clients add column if not exists utm_medium text;
alter table clients add column if not exists utm_campaign text;
alter table clients add column if not exists utm_term text;
alter table clients add column if not exists utm_content text;
alter table clients add column if not exists gclid text;
alter table clients add column if not exists landing_page text;
alter table clients add column if not exists referrer text;
alter table clients add column if not exists first_touch_at timestamptz;

-- ── quotes ───────────────────────────────────────────────────────────────

create type quote_status as enum ('draft', 'sent', 'accepted', 'declined', 'expired');

create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  client_id uuid not null references clients (id) on delete cascade,
  status quote_status not null default 'draft',
  amount_cents integer,
  currency text not null default 'EUR',
  notes text,
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists quotes_tenant_id_idx on quotes (tenant_id);
create index if not exists quotes_client_id_idx on quotes (client_id);
create index if not exists quotes_status_idx on quotes (status);

-- ── bookings ─────────────────────────────────────────────────────────────

create type booking_status as enum ('confirmed', 'completed', 'cancelled');

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  client_id uuid not null references clients (id) on delete cascade,
  quote_id uuid references quotes (id) on delete set null,
  status booking_status not null default 'confirmed',
  currency text not null default 'EUR',
  deposit_amount_cents integer,
  deposit_paid_at timestamptz,
  final_amount_cents integer,
  scheduled_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  invoiced_at timestamptz,
  invoice_amount_cents integer,
  paid_at timestamptz,
  paid_amount_cents integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bookings_tenant_id_idx on bookings (tenant_id);
create index if not exists bookings_client_id_idx on bookings (client_id);
create index if not exists bookings_quote_id_idx on bookings (quote_id);
create index if not exists bookings_status_idx on bookings (status);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Staff (admin + dispatcher) access, same pattern as clients — quotes and
-- bookings are day-to-day operational data dispatchers need too, unlike
-- the admin-only marketing/ad-spend tables.

alter table quotes enable row level security;
alter table bookings enable row level security;

create policy "staff can view quotes in their tenant"
  on quotes for select
  using (tenant_id = auth_tenant_id() and auth_role() in ('admin', 'dispatcher'));

create policy "staff can insert quotes in their tenant"
  on quotes for insert
  with check (tenant_id = auth_tenant_id() and auth_role() in ('admin', 'dispatcher'));

create policy "staff can update quotes in their tenant"
  on quotes for update
  using (tenant_id = auth_tenant_id() and auth_role() in ('admin', 'dispatcher'));

create policy "staff can view bookings in their tenant"
  on bookings for select
  using (tenant_id = auth_tenant_id() and auth_role() in ('admin', 'dispatcher'));

create policy "staff can insert bookings in their tenant"
  on bookings for insert
  with check (tenant_id = auth_tenant_id() and auth_role() in ('admin', 'dispatcher'));

create policy "staff can update bookings in their tenant"
  on bookings for update
  using (tenant_id = auth_tenant_id() and auth_role() in ('admin', 'dispatcher'));

-- ── public lead capture ─────────────────────────────────────────────────
-- transfer-web's "Request a Quote" form creates a client row while
-- unauthenticated. Kept for RLS completeness/defense-in-depth, but see the
-- important caveat below: this is not the actual enforcement boundary
-- today.

create policy "anyone can submit a lead"
  on clients for insert
  with check (true);

-- CAVEAT (worth being honest about, not discovered until this migration):
-- packages/db's getDb() connects via a direct DATABASE_URL Postgres
-- connection, not through Supabase's PostgREST/client-library path. That
-- means auth.uid() — and therefore auth_tenant_id()/auth_role(), and every
-- RLS policy in this codebase — only actually engages if DATABASE_URL
-- connects as a non-superuser role with request.jwt.claims populated per
-- request. Supabase's standard DATABASE_URL connects as the `postgres`
-- role, which has BYPASSRLS and skips all of this by default. In today's
-- architecture, the real, reliably-enforced authorization boundary is the
-- tRPC procedure layer (publicProcedure/staffProcedure/adminProcedure in
-- packages/core/src/trpc.ts), not these RLS policies. They remain correct
-- SQL and real defense-in-depth if the connection model changes, but
-- should not be assumed to be independently blocking anything right now.
