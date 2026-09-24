-- Bonolini OS — WhatsApp quote approval flow
--
-- Hand-written to match `pnpm --filter @bos/db run generate` output style
-- (drizzle-kit's own snapshot bookkeeping is stale past migration 0009 —
-- same caveat every migration since 0018 documents). Purely additive: two
-- nullable columns on transfer_requests, two new tables. Nothing existing
-- is altered or dropped.
--
-- See packages/core/src/quote-approval/README.md: the customer is asked for
-- missing data automatically (fixed text, no price); the founder receives
-- "PREVENTIVO PRONTO" with APPROVA / MODIFICA / RIFIUTA; the quote reaches
-- the customer only after APPROVA.

ALTER TABLE "transfer_requests" ADD COLUMN "children" integer;--> statement-breakpoint
ALTER TABLE "transfer_requests" ADD COLUMN "children_ages" text;--> statement-breakpoint

CREATE TABLE "founder_whatsapp_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"whatsapp_message_id" text NOT NULL,
	"type" text NOT NULL,
	"raw_text" text,
	"button_id" text,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "founder_whatsapp_messages_tenant_message_unique" UNIQUE("tenant_id","whatsapp_message_id")
);
--> statement-breakpoint
ALTER TABLE "founder_whatsapp_messages" ADD CONSTRAINT "founder_whatsapp_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "founder_whatsapp_messages_tenant_received_idx" ON "founder_whatsapp_messages" USING btree ("tenant_id","received_at");--> statement-breakpoint

CREATE TABLE "quote_approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transfer_request_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"proposed_amount_cents" integer,
	"notification_status" text DEFAULT 'pending' NOT NULL,
	"notification_channel" text,
	"notification_error" text,
	"notified_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decision_error" text,
	"customer_communication_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_approval_requests_kind_check" CHECK ("kind" IN ('quote_ready', 'manual_price_required')),
	CONSTRAINT "quote_approval_requests_status_check" CHECK ("status" IN ('awaiting_decision', 'awaiting_price', 'processing', 'approved', 'rejected', 'superseded', 'info')),
	CONSTRAINT "quote_approval_requests_notification_status_check" CHECK ("notification_status" IN ('pending', 'sending', 'sent_whatsapp', 'sent_email', 'failed')),
	CONSTRAINT "quote_approval_requests_round_unique" UNIQUE("tenant_id","transfer_request_id","kind","round")
);
--> statement-breakpoint
ALTER TABLE "quote_approval_requests" ADD CONSTRAINT "quote_approval_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_approval_requests" ADD CONSTRAINT "quote_approval_requests_transfer_request_id_transfer_requests_id_fk" FOREIGN KEY ("transfer_request_id") REFERENCES "public"."transfer_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_approval_requests" ADD CONSTRAINT "quote_approval_requests_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_approval_requests" ADD CONSTRAINT "quote_approval_requests_customer_communication_id_communications_id_fk" FOREIGN KEY ("customer_communication_id") REFERENCES "public"."communications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_approval_requests_tenant_status_idx" ON "quote_approval_requests" USING btree ("tenant_id","status");--> statement-breakpoint
-- At most one open round per transfer_request, and at most one round per
-- tenant waiting for the founder's typed price: a bare "280" must never be
-- ambiguous about which quote it prices.
CREATE UNIQUE INDEX "quote_approval_requests_one_open_round_idx" ON "quote_approval_requests" USING btree ("tenant_id","transfer_request_id") WHERE "status" IN ('awaiting_decision', 'awaiting_price', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX "quote_approval_requests_one_awaiting_price_idx" ON "quote_approval_requests" USING btree ("tenant_id") WHERE "status" = 'awaiting_price';--> statement-breakpoint

ALTER TABLE "founder_whatsapp_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quote_approval_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "admins can view founder whatsapp messages in their tenant" ON "founder_whatsapp_messages" FOR SELECT USING (tenant_id = auth_tenant_id() AND auth_role() = 'admin');--> statement-breakpoint
CREATE POLICY "staff can view quote approval requests in their tenant" ON "quote_approval_requests" FOR SELECT USING (tenant_id = auth_tenant_id() AND auth_role() IN ('admin', 'dispatcher'));
