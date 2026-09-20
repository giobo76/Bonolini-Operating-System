-- Bonolini OS — BOS Business Intelligence + Autonomy Model, Phase 2.5:
-- persistent Deal / Trattativa
--
-- Hand-written to match `pnpm --filter @bos/db run generate` output style
-- (drizzle-kit's own snapshot bookkeeping is stale past migration 0009 —
-- same caveat every migration since 0018 documents). Purely additive: one
-- new table (deals), one new enum (deal_status), and four new NULLABLE
-- deal_id columns on transfer_requests/whatsapp_messages/quotes/bookings.
-- No existing table/column/enum/constraint/index is altered or dropped.
--
-- Fixes the architectural gap a real production incident exposed
-- (2026-09-18: one client, four transfer_requests, the same €300 fixed
-- fare computed twice, a card-payment question landing on a
-- transfer_request with no price ever attached to it) — see
-- packages/core/src/deals/README.md for the full rationale and matching
-- algorithm, and packages/core/src/transfer-requests/README.md's
-- "Deal layer (Phase 2.5)" section for how this connects to the existing
-- transfer_request state machine, which this migration does not change.

CREATE TYPE "public"."deal_status" AS ENUM('open', 'quoted', 'confirmed', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"status" "deal_status" DEFAULT 'open' NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_reported_payment_note" text,
	"customer_reported_payment_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deals_tenant_client_status_idx" ON "deals" USING btree ("tenant_id","client_id","status");--> statement-breakpoint
CREATE INDEX "deals_tenant_client_idx" ON "deals" USING btree ("tenant_id","client_id");--> statement-breakpoint

ALTER TABLE "transfer_requests" ADD COLUMN "deal_id" uuid;--> statement-breakpoint
ALTER TABLE "transfer_requests" ADD CONSTRAINT "transfer_requests_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transfer_requests_deal_id_idx" ON "transfer_requests" USING btree ("deal_id");--> statement-breakpoint

ALTER TABLE "whatsapp_messages" ADD COLUMN "deal_id" uuid;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_messages_deal_id_idx" ON "whatsapp_messages" USING btree ("deal_id");--> statement-breakpoint

ALTER TABLE "quotes" ADD COLUMN "deal_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quotes_deal_id_idx" ON "quotes" USING btree ("deal_id");--> statement-breakpoint

ALTER TABLE "bookings" ADD COLUMN "deal_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_deal_id_idx" ON "bookings" USING btree ("deal_id");
