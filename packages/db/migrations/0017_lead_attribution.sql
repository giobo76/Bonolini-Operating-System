-- Bonolini OS — lead attribution (contact_token / visitor_id / candidate
-- review), CERTAIN / AMBIGUOUS / UNKNOWN as a stored, queryable fact
--
-- Generated via `pnpm --filter @bos/db run generate`, then renamed from
-- drizzle-kit's own 0009_pink_stardust.sql to match this project's real,
-- continuous migration numbering — same convention 0014/0015/0016's own
-- header comments document. Journal entry idx 9 updated to match;
-- meta/0009_snapshot.json deliberately left with drizzle-kit's own
-- idx-based filename.
--
-- marketing_leads.attribution_confidence/attribution_method: a lead is
-- only ever "certain" via contact_token, visitor_id, or an explicit human
-- confirmation (manual_admin) — never via time proximity alone, per the
-- founder's explicit, binding instruction (2026-09), even when only one
-- candidate exists. Time-proximity findings live exclusively in
-- lead_match_candidates below and mark the lead "ambiguous" — never
-- promoted to "certain" by any code path.
--
-- marketing_leads.contact_token: generated only for channel in (whatsapp,
-- email) at lead creation, returned to the caller of the public
-- lead-intent endpoint so the real inbound reply can carry it back. The
-- partial unique index below (added by hand — drizzle-kit's schema
-- builder cannot express a partial WHERE) is the real uniqueness
-- guarantee, same technique already used for clients' phone partial
-- unique index (see 0009_clients_phone_unique_per_tenant.sql).
--
-- clients.visitor_id: the deterministic bridge for channel=form leads —
-- never set retroactively, never backfilled onto a client that already
-- existed before the matching lead was created (see marketing/service.ts's
-- confirmLeadByContactToken: acquisition fields on clients are write-once,
-- set only at the moment a brand-new client row is created, never touched
-- by any later lead-linking activity, manual or automatic).
--
-- lead_match_candidates: the only place a time-proximity heuristic finding
-- is ever recorded. Never written by anything but the heuristic detector
-- (marketing/lead-matching.ts); never itself sets marketing_leads.client_id
-- or touches any client column.

CREATE TYPE "public"."lead_attribution_confidence" AS ENUM('certain', 'ambiguous', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."lead_attribution_method" AS ENUM('contact_token', 'visitor_id', 'manual_admin', 'none');--> statement-breakpoint
CREATE TYPE "public"."lead_match_method" AS ENUM('whatsapp_time_proximity');--> statement-breakpoint
CREATE TABLE "lead_match_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"marketing_lead_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"method" "lead_match_method" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_match_candidates_lead_client_unique" UNIQUE("marketing_lead_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "visitor_id" text;--> statement-breakpoint
ALTER TABLE "marketing_leads" ADD COLUMN "contact_token" text;--> statement-breakpoint
ALTER TABLE "marketing_leads" ADD COLUMN "attribution_confidence" "lead_attribution_confidence" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_leads" ADD COLUMN "attribution_method" "lead_attribution_method" DEFAULT 'none' NOT NULL;--> statement-breakpoint
-- Partial unique index: only rows that actually have a token need to be
-- unique per tenant — most leads (phone/form channel) never get one.
CREATE UNIQUE INDEX "marketing_leads_tenant_contact_token_unique" ON "marketing_leads" ("tenant_id", "contact_token") WHERE "contact_token" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_match_candidates" ADD CONSTRAINT "lead_match_candidates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_match_candidates" ADD CONSTRAINT "lead_match_candidates_marketing_lead_id_marketing_leads_id_fk" FOREIGN KEY ("marketing_lead_id") REFERENCES "public"."marketing_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_match_candidates" ADD CONSTRAINT "lead_match_candidates_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;