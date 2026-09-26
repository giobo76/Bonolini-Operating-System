import { getCalendarClient } from "../marketing";
import { romeWallClockToUtc, toValidDate } from "../dates";
import { captureException } from "../observability";
import { getCalendarConnectionRow } from "./service";
import { isBosEventId } from "./schema";

// Read-only: the events of the selected calendar that overlap a time range,
// for the overlap check in PREVENTIVO PRONTO (founder decisions 2026-09-26).
// Only events.list — never a write.

export interface CalendarBusyEvent {
  id: string;
  summary: string | null;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
}

export type CalendarBusyEventsResult =
  | { status: "ok"; events: CalendarBusyEvent[] }
  | { status: "not_connected" }
  | { status: "error"; message: string };

interface GoogleEventTime {
  dateTime?: string | null;
  date?: string | null;
}

interface GoogleEvent {
  id?: string | null;
  status?: string | null;
  summary?: string | null;
  transparency?: string | null;
  start?: GoogleEventTime | null;
  end?: GoogleEventTime | null;
  extendedProperties?: { private?: Record<string, string> | null } | null;
}

// An all-day event ("2026-10-03" to "2026-10-04", end exclusive) covers
// that whole day in Europe/Rome.
function eventTime(time: GoogleEventTime | null | undefined): { at: Date; allDay: boolean } | null {
  if (time?.dateTime) {
    const at = toValidDate(time.dateTime);
    return at ? { at, allDay: false } : null;
  }
  if (time?.date) {
    const at = romeWallClockToUtc(time.date, "00:00");
    return at ? { at, allDay: true } : null;
  }
  return null;
}

export function toCalendarBusyEvent(event: GoogleEvent): CalendarBusyEvent | null {
  if (!event.id || event.status === "cancelled") return null;
  // "Libero" in Google Calendar: the founder is not busy.
  if (event.transparency === "transparent") return null;
  // Created by BOS for a booking: the booking itself is compared.
  if (isBosEventId(event.id) || event.extendedProperties?.private?.bosBookingId) return null;
  const start = eventTime(event.start);
  const end = eventTime(event.end);
  if (!start || !end || end.at.getTime() <= start.at.getTime()) return null;
  return { id: event.id, summary: event.summary ?? null, startAt: start.at, endAt: end.at, allDay: start.allDay };
}

export async function listCalendarBusyEvents(tenantId: string, from: Date, to: Date): Promise<CalendarBusyEventsResult> {
  const connection = await getCalendarConnectionRow(tenantId);
  if (!connection) return { status: "not_connected" };

  try {
    const calendarApi = await getCalendarClient(tenantId);
    const events: CalendarBusyEvent[] = [];
    let pageToken: string | undefined;
    do {
      const response = await calendarApi.events.list({
        calendarId: connection.googleCalendarId,
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: true,
        maxResults: 250,
        pageToken,
      });
      for (const item of (response.data.items ?? []) as GoogleEvent[]) {
        const busy = toCalendarBusyEvent(item);
        if (busy) events.push(busy);
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return { status: "ok", events };
  } catch (error) {
    captureException(error, "calendar.busy_events.failed", { tenantId });
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
