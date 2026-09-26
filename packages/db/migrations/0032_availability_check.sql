-- Bonolini OS — real overlap check for PREVENTIVO PRONTO
--
-- Hand-written to match drizzle-kit output style (see 0030's note on the
-- stale snapshots). Purely additive: two nullable jsonb columns. Requires
-- 0030.
--
-- Founder decisions 2026-09-26: "Disponibilità: compatibile" was printed
-- without comparing anything. Each PREVENTIVO PRONTO round now stores the
-- overlap check it showed (bookings + Google Calendar), and each booking
-- stores the founder's busy window for the service (Sondrio loop + route
-- minimums), copied at Approva, so later checks and the calendar event use
-- the same window.

ALTER TABLE "bookings" ADD COLUMN "busy_window" jsonb;--> statement-breakpoint
ALTER TABLE "quote_approval_requests" ADD COLUMN "availability_check" jsonb;
