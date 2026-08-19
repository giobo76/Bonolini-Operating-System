-- Bonolini OS — Transfer Request foundation
--
-- Hand-authored (no Node/drizzle-kit available). Verify with `pnpm db:generate`
-- once dependencies are installed.
--
-- Context: whatsapp_messages (per-message immutable log) and quotes
-- (official, frozen preventivo snapshot) already exist, but nothing sits
-- between them — no way to represent "a commercial request currently being
-- assembled across one or more WhatsApp messages, not yet priced or sent."
-- transfer_requests is that layer. See
-- packages/core/src/transfer-requests/README.md for the full lifecycle,
-- matching, and merge rules this table implements.

-- ── transfer_requests ────────────────────────────────────────────────────

create type transfer_request_status as enum (
  'collecting_info',
  'ready_for_pricing',
  'pending_admin_approval',
  'approved',
  'converted_to_quote',
  'cancelled',
  'expired'
);

-- Deliberately separate from transfer_request_status — see schema.ts's
-- comment: this is the pricing engine's (not yet built) outcome, not a
-- workflow stage. No 'priced' workflow status exists; this enum alone
-- carries that information once the engine runs.
create type transfer_request_pricing_status as enum (
  'not_priced',
  'fixed',
  'calculated_km',
  'manual_required'
);

create table if not exists transfer_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  client_id uuid not null references clients (id) on delete cascade,
  status transfer_request_status not null default 'collecting_info',
  intent text,
  pickup text,
  pickup_address text,
  destination text,
  destination_address text,
  requested_date date,
  requested_time text,
  passengers integer,
  luggage text,
  flight_number text,
  train_number text,
  hotel text,
  language text,
  missing_information text[],
  pricing_status transfer_request_pricing_status not null default 'not_priced',
  calculated_amount_cents integer,
  currency text not null default 'EUR',
  pricing_breakdown jsonb,
  quote_id uuid references quotes (id) on delete set null,
  admin_approved_at timestamptz,
  admin_approved_by uuid references profiles (id) on delete set null,
  cancelled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The race-prevention boundary: at most one OPEN request per (tenant,
-- client) at a time. Deliberately scoped to ('collecting_info',
-- 'ready_for_pricing') only — NOT the full 4-state "open" set originally
-- drafted in the matching spec (which also listed pending_admin_approval/
-- approved). A request in pending_admin_approval/approved must never block
-- a new one from opening (a human is already reviewing it and it must never
-- be silently modified); a client CAN legitimately have one
-- pending_admin_approval/approved request plus one fresh collecting_info
-- request at the same time — only the "nobody has reviewed this yet"
-- states need the hard one-at-a-time guarantee. Confirmed by the founder
-- (decision A) after being raised as a deviation during implementation —
-- see packages/core/src/transfer-requests/README.md's "Founder decisions"
-- section.
create unique index if not exists transfer_requests_tenant_client_open_idx
  on transfer_requests (tenant_id, client_id)
  where status in ('collecting_info', 'ready_for_pricing');

create index if not exists transfer_requests_tenant_client_idx on transfer_requests (tenant_id, client_id);
create index if not exists transfer_requests_tenant_status_idx on transfer_requests (tenant_id, status);
create index if not exists transfer_requests_quote_id_idx on transfer_requests (quote_id);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Same tier and same caveat as quotes/bookings (0004_funnel_attribution.sql):
-- staff (admin + dispatcher) access; this app's DATABASE_URL connects as the
-- `postgres` role (BYPASSRLS), so the real enforcement boundary is the
-- service layer, not this policy — kept for defense-in-depth and
-- correctness if the connection model ever changes.

alter table transfer_requests enable row level security;

create policy "staff can view transfer requests in their tenant"
  on transfer_requests for select
  using (tenant_id = auth_tenant_id() and auth_role() in ('admin', 'dispatcher'));

create policy "staff can insert transfer requests in their tenant"
  on transfer_requests for insert
  with check (tenant_id = auth_tenant_id() and auth_role() in ('admin', 'dispatcher'));

create policy "staff can update transfer requests in their tenant"
  on transfer_requests for update
  using (tenant_id = auth_tenant_id() and auth_role() in ('admin', 'dispatcher'));

-- ── whatsapp_messages: link back to the request it was merged into ──────

alter table whatsapp_messages add column if not exists transfer_request_id uuid references transfer_requests (id) on delete set null;

create index if not exists whatsapp_messages_transfer_request_id_idx on whatsapp_messages (transfer_request_id);
