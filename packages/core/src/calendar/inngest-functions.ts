import { inngest } from "@bos/jobs";
import { getDb, tenants } from "@bos/db";
import { syncCalendarEvents } from "./service";
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

export const calendarInngestFunctions = [calendarSync];
