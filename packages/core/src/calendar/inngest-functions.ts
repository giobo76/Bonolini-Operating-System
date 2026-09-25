import { inngest } from "@bos/jobs";
import { getDb, tenants } from "@bos/db";
import { syncCalendarEvents } from "./service";
import { createCalendarEventForBooking, markCalendarEventCancelledForBooking } from "./booking-event";
import { captureException, log } from "../observability";

async function listAllTenantIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db.select({ id: tenants.id }).from(tenants);
  return rows.map((r) => r.id);
}

// Every 15 minutes — reasonable for a booking calendar (near-real-time
// without hammering the Calendar API quota); not "every second," per the
// founder's explicit instruction. Each tenant's sync runs inside its own
// step.run() so Inngest memoizes it and a retry only re-runs the tenant
// that actually failed — same discipline as marketing's own
// quick-check/daily-audit/weekly-report functions (Production Roadmap
// Milestone 1.5), and syncCalendarEvents itself is already idempotent
// (bookings.calendar_event_id unique + upsert), so even a genuine
// re-execution of the same tenant's step can never duplicate a booking. A
// tenant with no calendar configured is a fast, safe no-op (see
// service.ts's syncCalendarEvents), so this never wastes real work on
// tenants that haven't opted in.
export const calendarSync = inngest.createFunction(
  { id: "calendar-sync" },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    log("calendar.sync.cron.start");
    const tenantIds = await step.run("list-tenants", listAllTenantIds);
    const results: Array<{ tenantId: string; ok: boolean }> = [];

    for (const tenantId of tenantIds) {
      try {
        await step.run(`calendar-sync-${tenantId}`, () => syncCalendarEvents(tenantId));
        results.push({ tenantId, ok: true });
      } catch (error) {
        captureException(error, "calendar.sync.cron.tenant_failed", { tenantId });
        results.push({ tenantId, ok: false });
      }
    }

    return results;
  },
);

// Founder decision 2026-09-25: a booking confirmed after the deposit gets
// its event in the founder's calendar. A failure (Google permission not
// granted yet, network) throws, so Inngest retries; the booking stays
// confirmed either way. Idempotent: the event id is derived from the
// booking, and bookings that already have an event are skipped.
export const calendarBookingEventOnConfirmed = inngest.createFunction(
  { id: "calendar-booking-event-on-confirmed" },
  { event: "booking.confirmed" },
  async ({ event, step }) => {
    const { tenantId, bookingId } = event.data as { tenantId: string; bookingId: string };
    return step.run("create-calendar-event", () => createCalendarEventForBooking(tenantId, bookingId));
  },
);

// Cancelled in BOS: the event stays, titled "ANNULLATO – …" and grey.
export const calendarBookingEventOnCancelled = inngest.createFunction(
  { id: "calendar-booking-event-on-cancelled" },
  { event: "booking.cancelled" },
  async ({ event, step }) => {
    const { tenantId, bookingId } = event.data as { tenantId: string; bookingId: string };
    return step.run("mark-calendar-event-cancelled", () => markCalendarEventCancelledForBooking(tenantId, bookingId));
  },
);

export const calendarInngestFunctions = [calendarSync, calendarBookingEventOnConfirmed, calendarBookingEventOnCancelled];
