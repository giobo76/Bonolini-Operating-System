export { calendarRouter } from "./router";
export {
  listAvailableCalendars,
  getCalendarConfig,
  selectCalendar,
  syncCalendarEvents,
} from "./service";
export { parseCalendarEvent, isRecognizableService } from "./schema";
export type {
  AvailableCalendar,
  CalendarConfigView,
  CalendarSyncResult,
  ParsedCalendarEvent,
  SelectCalendarInput,
} from "./schema";
export { calendarInngestFunctions } from "./inngest-functions";
export type { CalendarConnection, NewCalendarConnection } from "@bos/db";

// Boundary rule (ADR 0002): other modules/apps import only from here. This
// module never reaches into clients/bookings/marketing internals — it
// consumes their own public boundaries (../clients, ../bookings,
// ../marketing) exactly like transfer-requests does, and it owns nothing
// those modules don't already expose a route into.
