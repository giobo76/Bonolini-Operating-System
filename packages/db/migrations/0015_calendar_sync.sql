-- Bonolini OS — Google Calendar sync (real conversions from confirmed
-- calendar services, no second source of truth)
--
-- Generated via `pnpm --filter @bos/db run generate` (Node/drizzle-kit
-- available in this environment, unlike 0006-0014), then renamed from
-- drizzle-kit's own 0007_oval_scream.sql to match this project's real,
-- continuous migration numbering — same convention 0014's own header
-- documents. Journal entry idx 7 updated to match; meta/0007_snapshot.json
-- deliberately left with drizzle-kit's own idx-based filename.
--
-- calendar_connections: one row per tenant (unique tenant_id) — which
-- Google Calendar was explicitly selected as "the Bonolini Transfer
-- services calendar," plus this module's own sync bookkeeping (sync_token
-- for incremental sync, last_synced_at/status/error). The Google OAuth
-- credential itself is NOT duplicated here — it stays in the existing
-- marketing_connections table; this table only ever references it via
-- tenant_id, reusing packages/core/src/marketing/google-clients.ts's
-- existing OAuth2Client construction.
--
-- bookings.calendar_event_id: unique (nullable) so the same Google
-- Calendar event can never produce more than one booking — a repeated or
-- retried sync of the same event converges on this one row. See
-- packages/core/src/bookings/service.ts::ensureBookingFromCalendarEvent
-- and packages/core/src/calendar/README.md for the full sync design.

CREATE TYPE "public"."calendar_sync_status" AS ENUM('ok', 'error');--> statement-breakpoint
CREATE TABLE "calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"google_calendar_id" text NOT NULL,
	"google_calendar_name" text,
	"timezone" text,
	"sync_token" text,
	"last_synced_at" timestamp with time zone,
	"last_sync_status" "calendar_sync_status",
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_connections_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "calendar_event_id" text;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_calendar_event_id_unique" UNIQUE("calendar_event_id");