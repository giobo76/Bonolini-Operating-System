-- Bonolini OS — Phase 3B: persist WhatsApp inbound metadata (discovery)
--
-- Hand-written to match `pnpm --filter @bos/db run generate` output style
-- (drizzle-kit's own snapshot bookkeeping is stale past migration 0009 —
-- same caveat every migration since 0018 documents). Purely additive: two
-- new NULLABLE columns on whatsapp_messages. No existing table/column/
-- enum/constraint/index is altered or dropped — Phase 2.5 and Phase 3
-- (deals, transfer_requests, quotes, bookings, communications) are
-- completely untouched by this migration.
--
-- Discovery/persistence only, per the founder's explicit scope for this
-- step: extracts phone_number_id/display_phone_number from Meta's real
-- inbound webhook payload (packages/core/src/whatsapp/schema.ts's
-- extractMessages) and stores them alongside the message they arrived
-- with. Nothing in this codebase sends WhatsApp messages, before or
-- after this migration — see packages/core/src/whatsapp/README.md's
-- "Hard constraints".

ALTER TABLE "whatsapp_messages" ADD COLUMN "phone_number_id" text;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD COLUMN "display_phone_number" text;
