import { router, adminProcedure } from "../trpc";
import { selectCalendarSchema } from "./schema";
import * as calendarService from "./service";

// adminProcedure only — same tier as the rest of /marketing/connections
// (marketingRouter's getConnectionStatus/upsertConnection). Calendar
// configuration is an admin-only setting, not a staff/dispatcher action.
export const calendarRouter = router({
  listAvailableCalendars: adminProcedure.query(({ ctx }) =>
    calendarService.listAvailableCalendars(ctx.session.profile.tenantId),
  ),

  getConfig: adminProcedure.query(({ ctx }) => calendarService.getCalendarConfig(ctx.session.profile.tenantId)),

  selectCalendar: adminProcedure.input(selectCalendarSchema).mutation(({ ctx, input }) =>
    calendarService.selectCalendar(ctx.session.profile.tenantId, input),
  ),

  // Manual "Sync now" — runs the same sync the Inngest cron uses,
  // synchronously, awaited by the caller. Same rationale as marketing's
  // own runCheckNow: lets the dashboard trigger a real sync without
  // needing the Inngest dev server.
  syncNow: adminProcedure.mutation(({ ctx }) => calendarService.syncCalendarEvents(ctx.session.profile.tenantId)),
});
