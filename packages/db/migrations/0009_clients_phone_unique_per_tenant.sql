-- Bonolini OS — WhatsApp → BOS integration, pre-commit hardening:
-- atomic "one client per phone number" guarantee
--
-- Hand-authored (no Node/drizzle-kit available). Verify with `pnpm db:generate`
-- once dependencies are installed.
--
-- Context: packages/core/src/whatsapp/service.ts's find-or-create-by-phone
-- flow was a SELECT-then-INSERT (check-then-act), not atomic — two
-- concurrent webhook deliveries for the same phone (different
-- whatsapp_message_id, so both pass the message-idempotency guard) could
-- each fail to find an existing client and both insert one, producing two
-- clients rows for the same person. This partial, tenant-scoped, functional
-- unique index is what makes `INSERT ... ON CONFLICT ... DO NOTHING`
-- atomic for that flow (see service.ts). Verified via a read-only
-- Production query before creating this: 0 clients rows exist today, so
-- there is nothing to conflict with.
--
-- Partial (WHERE deleted_at IS NULL): a soft-deleted client must never
-- block a new client from being created with the same phone number —
-- matches clients' existing soft-delete semantics (see
-- packages/core/src/clients/service.ts).
--
-- Functional (on the digits-only normalization, not the raw column):
-- clients.phone carries no format guarantee (hand-entered via the web lead
-- form) — see service.ts's normalizePhone. regexp_replace with a fixed
-- pattern/flags is IMMUTABLE, so it's usable in a functional index.

create unique index if not exists clients_tenant_normalized_phone_idx
  on clients (tenant_id, (regexp_replace(phone, '[^0-9]', '', 'g')))
  where deleted_at is null;
