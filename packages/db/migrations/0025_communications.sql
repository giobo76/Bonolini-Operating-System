-- Bonolini OS — BOS Agent Phase 3: Approval -> Execution -> Verification
-- for outbound customer communications
--
-- Hand-written to match `pnpm --filter @bos/db run generate` output style
-- (drizzle-kit's own snapshot bookkeeping is stale past migration 0009 —
-- same caveat every migration since 0018 documents). Purely additive: one
-- new table (communications), one new enum (communication_status). No
-- existing table/column/enum/constraint/index is altered or dropped —
-- Phase 2.5 (deals, transfer_requests, quotes, bookings) is completely
-- untouched by this migration.
--
-- See packages/core/src/communications/README.md for the full state
-- machine and rationale: a communication may be prepared from real deal/
-- quote/client data, but the founder's rule is that nothing is ever sent
-- to a real customer without explicit approval — enforced here by
-- @bos/ai's Policy Engine (customer_communication is always
-- approval-required) plus the status column's own state machine.

CREATE TYPE "public"."communication_status" AS ENUM('prepared', 'pending_approval', 'approved', 'executed', 'verified', 'execution_failed', 'rejected');--> statement-breakpoint
CREATE TABLE "communications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"deal_id" uuid,
	"transfer_request_id" uuid,
	"quote_id" uuid,
	"booking_id" uuid,
	"channel" text NOT NULL,
	"action" text NOT NULL,
	"agent" text NOT NULL,
	"correlation_id" text,
	"idempotency_key" text NOT NULL,
	"content" jsonb NOT NULL,
	"status" "communication_status" DEFAULT 'prepared' NOT NULL,
	"policy_decision" jsonb,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"provider" text,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "communications_tenant_idempotency_key_unique" UNIQUE("tenant_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_transfer_request_id_transfer_requests_id_fk" FOREIGN KEY ("transfer_request_id") REFERENCES "public"."transfer_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_approved_by_profiles_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "communications_tenant_deal_idx" ON "communications" USING btree ("tenant_id","deal_id");--> statement-breakpoint
CREATE INDEX "communications_tenant_status_idx" ON "communications" USING btree ("tenant_id","status");
