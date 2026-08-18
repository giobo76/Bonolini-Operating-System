-- Bonolini OS — WhatsApp → BOS integration, Phase 1: inbound message log
--
-- Hand-authored (no Node/drizzle-kit available). Verify with `pnpm db:generate`
-- once dependencies are installed.
--
-- Context: neither `clients` (a single overwritable `notes` field, no
-- message-id concept), `quotes` (status+amount skeleton, no trip-detail
-- fields), nor `marketing_leads` (deliberately anonymous — no phone/text)
-- can hold per-message WhatsApp data with real idempotency. This table is
-- the minimal addition needed for: idempotency (unique whatsapp_message_id),
-- audit/history (one row per inbound message, never overwritten), and the
-- Claude-parsed structured fields per message. See
-- packages/core/src/whatsapp/README.md.

create table if not exists whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  -- Set once the sender's phone is matched/created against `clients` — see
  -- packages/core/src/whatsapp/service.ts. The message log outlives the
  -- client relationship (on delete set null), unlike the client itself.
  client_id uuid references clients (id) on delete set null,
  whatsapp_message_id text not null,
  from_phone text not null,
  raw_text text not null,
  parsed jsonb,
  received_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- The real idempotency boundary (see service.ts): a duplicate delivery of
-- the same Meta message id must fail this constraint, not rely on an
-- in-memory check. Composite with tenant_id, not global — matches ADR
-- 0004's multi-tenancy discipline (never assume single-tenancy just because
-- it's true today): a message id is only guaranteed unique within the
-- WhatsApp Business Account it came from, and each tenant will eventually
-- connect its own. This migration has not been applied anywhere yet, so
-- this composite index replaces the original single-column definition
-- directly rather than layering a follow-up migration on top of it.
create unique index if not exists whatsapp_messages_tenant_message_id_idx on whatsapp_messages (tenant_id, whatsapp_message_id);
create index if not exists whatsapp_messages_client_id_idx on whatsapp_messages (client_id);
create index if not exists whatsapp_messages_from_phone_idx on whatsapp_messages (from_phone);
create index if not exists whatsapp_messages_tenant_id_idx on whatsapp_messages (tenant_id);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Same tier and same caveat as marketing_leads/findings (0006_marketing_leads.sql):
-- staff/admin read access; this app's DATABASE_URL connects as the
-- `postgres` role (BYPASSRLS), so the real enforcement boundary is the
-- webhook handler + service layer, not this policy — kept for
-- defense-in-depth and correctness if the connection model ever changes.
-- No public insert policy: unlike marketing_leads, this table is never
-- written to directly by an unauthenticated client — only the webhook
-- route (server-side, signature-verified) writes here.

alter table whatsapp_messages enable row level security;

create policy "admin can view whatsapp messages in their tenant"
  on whatsapp_messages for select
  using (tenant_id = auth_tenant_id() and auth_role() = 'admin');
