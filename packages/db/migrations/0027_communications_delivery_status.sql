-- Bonolini OS — Phase 3B Step 3: WhatsApp Cloud API outbound provider —
-- delivery-status tracking columns on communications
--
-- Hand-written to match `pnpm --filter @bos/db run generate` output style
-- (drizzle-kit's own snapshot bookkeeping is stale past migration 0009 —
-- same caveat every migration since 0018 documents). Purely additive:
-- three new NULLABLE columns on communications. No existing table/column/
-- enum/constraint/index is altered or dropped — Phase 2.5 (deals,
-- transfer_requests, quotes, bookings) is completely untouched, and no
-- existing communications row's `status`/`provider`/`provider_message_id`
-- is rewritten by this migration.
--
-- Why: messages[0].id on Meta's synchronous POST response only proves
-- Meta ACCEPTED the send request, never that it was delivered or read —
-- executed != verified. provider_status/provider_status_updated_at record
-- Meta's own async delivery-status webhook callbacks (sent/delivered/
-- read/failed); verified_at records the one moment `communications.status`
-- first genuinely reaches "verified" (packages/core/src/communications/service.ts's
-- recordProviderDeliveryStatus).

ALTER TABLE "communications" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "provider_status_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "verified_at" timestamp with time zone;
