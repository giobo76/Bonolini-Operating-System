import { eq } from "drizzle-orm";
import { getDb, calendarConnections, type CalendarConnection } from "@bos/db";
import { getCalendarClient } from "../marketing";
import { findClientByPhone, findOrCreateClientByPhone } from "../clients";
import { ensureBookingFromCalendarEvent, getBookingByCalendarEventId, cancelBookingByCalendarEventId } from "../bookings";
import { log, captureException } from "../observability";
import { parseCalendarEvent, isRecognizableService } from "./schema";
import type {
  AvailableCalendar,
  CalendarConfigView,
  CalendarSyncResult,
  SelectCalendarInput,
} from "./schema";

// First-ever sync (no syncToken yet) is bounded to a reasonable lookback
// window rather than pulling a calendar's entire history — 90 days covers
// any transfer realistically still relevant to "real conversions." Every
// sync after this one is incremental (syncToken-based), so this window
// only ever matters once, or again after a syncToken invalidation forces a
// controlled full resync (see runSingleSyncPass).
const FULL_SYNC_LOOKBACK_DAYS = 90;

export async function listAvailableCalendars(tenantId: string): Promise<AvailableCalendar[]> {
  const calendarApi = await getCalendarClient(tenantId);
  const response = await calendarApi.calendarList.list();

  return (response.data.items ?? [])
    .filter((item) => Boolean(item.id))
    .map((item) => ({
      id: item.id!,
      name: item.summary ?? item.id!,
      timezone: item.timeZone ?? null,
      accessRole: item.accessRole ?? null,
    }));
}

export async function getCalendarConfig(tenantId: string): Promise<CalendarConfigView> {
  const row = await getCalendarConnectionRow(tenantId);
  if (!row) {
    return {
      configured: false,
      googleCalendarId: null,
      googleCalendarName: null,
      timezone: null,
      lastSyncedAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
    };
  }
  return {
    configured: true,
    googleCalendarId: row.googleCalendarId,
    googleCalendarName: row.googleCalendarName,
    timezone: row.timezone,
    lastSyncedAt: row.lastSyncedAt,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncError: row.lastSyncError,
  };
}

async function getCalendarConnectionRow(tenantId: string): Promise<CalendarConnection | null> {
  const db = getDb();
  const [row] = await db.select().from(calendarConnections).where(eq(calendarConnections.tenantId, tenantId));
  return row ?? null;
}

// Persistent, per-tenant configuration — never invents a calendar ID: the
// caller (the router, fed by listAvailableCalendars above) must supply one
// Google actually returned. Selecting a (new) calendar always clears any
// previous sync_token: switching calendars invalidates whatever
// incremental-sync position applied to the old one, so the next sync must
// start fresh (a controlled full resync of the newly selected calendar,
// not an attempt to resume a token that belongs to a different calendar).
export async function selectCalendar(tenantId: string, input: SelectCalendarInput): Promise<void> {
  const db = getDb();
  const existing = await getCalendarConnectionRow(tenantId);

  if (existing) {
    await db
      .update(calendarConnections)
      .set({
        googleCalendarId: input.googleCalendarId,
        googleCalendarName: input.googleCalendarName,
        timezone: input.timezone,
        syncToken: null,
        lastSyncedAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(calendarConnections.id, existing.id));
    return;
  }

  await db.insert(calendarConnections).values({
    tenantId,
    googleCalendarId: input.googleCalendarId,
    googleCalendarName: input.googleCalendarName,
    timezone: input.timezone,
  });
}

function emptyResult(): CalendarSyncResult {
  return {
    eventsSeen: 0,
    bookingsCreated: 0,
    bookingsUpdated: 0,
    bookingsCancelled: 0,
    eventsSkippedNoClientData: 0,
    eventsIgnoredNotAService: 0,
    fullResync: false,
  };
}

// Google's googleapis/Gaxios client surfaces an invalid/expired syncToken
// as HTTP 410 Gone — checked in both places the status can land depending
// on library version, same defensive-checking discipline already used for
// invalid_grant detection in marketing/google-clients.ts.
function isSyncTokenInvalidError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const withCode = error as { code?: number | string; response?: { status?: number } };
  return withCode.code === 410 || withCode.code === "410" || withCode.response?.status === 410;
}

type CalendarApi = Awaited<ReturnType<typeof getCalendarClient>>;

// One event -> at most one booking mutation. Never calls the Calendar API
// itself (that's the caller's job, paginating events.list) — this is the
// per-event decision tree: cancelled -> cancel the existing booking (if
// any); not a recognizable service (no pickup -> destination route) ->
// ignored, exactly like a personal "Dentist appointment" on the same
// calendar; recognizable but no client data resolvable -> skipped and
// counted, never silently dropped and never given invented contact data.
async function processEvent(
  tenantId: string,
  event: { id?: string | null; status?: string | null; summary?: string | null; description?: string | null; start?: { dateTime?: string | null } | null },
  result: CalendarSyncResult,
): Promise<void> {
  if (!event.id) return;
  result.eventsSeen += 1;

  if (event.status === "cancelled") {
    const cancelled = await cancelBookingByCalendarEventId(tenantId, event.id);
    if (cancelled) result.bookingsCancelled += 1;
    return;
  }

  const parsed = parseCalendarEvent(event.summary ?? "", event.description ?? null);
  if (!isRecognizableService(parsed)) {
    result.eventsIgnoredNotAService += 1;
    return;
  }

  const existingBooking = await getBookingByCalendarEventId(tenantId, event.id);

  let clientId: string;
  if (existingBooking) {
    // Re-sync of a known event: never re-attributes an existing booking to
    // a different client (see bookings/service.ts's own comment on why).
    clientId = existingBooking.clientId;
  } else if (parsed.phone) {
    const existingClient = await findClientByPhone(tenantId, parsed.phone);
    if (existingClient) {
      clientId = existingClient.id;
    } else if (parsed.clientName) {
      const eventStart = event.start?.dateTime ? new Date(event.start.dateTime) : new Date();
      const newClient = await findOrCreateClientByPhone(tenantId, parsed.phone, parsed.clientName, eventStart, {
        gclid: parsed.gclid,
        utmSource: parsed.utmSource,
        utmCampaign: parsed.utmCampaign,
      });
      clientId = newClient.id;
    } else {
      // A phone was found but no name — creating a client requires both
      // (fullName is NOT NULL, and inventing a placeholder name is exactly
      // the fabrication this milestone rules out). Counted, never dropped
      // silently.
      result.eventsSkippedNoClientData += 1;
      return;
    }
  } else {
    // No phone at all -> cannot identify or create a client (phone is
    // required and unique-per-tenant). This is the real, honest limitation
    // documented in the module's README: a calendar event needs a
    // "Phone: ..." line in its description to auto-create a booking.
    result.eventsSkippedNoClientData += 1;
    return;
  }

  const scheduledAt = event.start?.dateTime ? new Date(event.start.dateTime) : null;

  await ensureBookingFromCalendarEvent(tenantId, {
    calendarEventId: event.id,
    clientId,
    pickup: parsed.pickup,
    destination: parsed.destination,
    scheduledAt,
    finalAmountCents: parsed.priceCents,
    currency: "EUR",
  });

  if (existingBooking) result.bookingsUpdated += 1;
  else result.bookingsCreated += 1;
}

// Paginates events.list to exhaustion, processing every page, and returns
// the final nextSyncToken (present only on the last page, per Google's
// API contract) — the caller persists it. Never combines timeMin with a
// syncToken (the API rejects that combination): timeMin is only ever
// passed on a full sync (syncToken undefined).
async function runSingleSyncPass(
  tenantId: string,
  calendarApi: CalendarApi,
  googleCalendarId: string,
  syncToken: string | undefined,
  result: CalendarSyncResult,
): Promise<string | null | undefined> {
  let pageToken: string | undefined;
  let nextSyncToken: string | null | undefined;

  do {
    const response = await calendarApi.events.list({
      calendarId: googleCalendarId,
      singleEvents: true,
      syncToken,
      pageToken,
      ...(syncToken ? {} : { timeMin: new Date(Date.now() - FULL_SYNC_LOOKBACK_DAYS * 86_400_000).toISOString() }),
    });

    for (const event of response.data.items ?? []) {
      await processEvent(tenantId, event, result);
    }

    pageToken = response.data.nextPageToken ?? undefined;
    if (response.data.nextSyncToken) nextSyncToken = response.data.nextSyncToken;
  } while (pageToken);

  return nextSyncToken;
}

// The main sync orchestrator — the one entry point both the manual "Sync
// now" tRPC mutation and the periodic Inngest job call. Never obligatory:
// a tenant with no calendar configured yet is a silent, valid no-op (see
// README.md's "Calendar is never required").
export async function syncCalendarEvents(tenantId: string): Promise<CalendarSyncResult> {
  const config = await getCalendarConnectionRow(tenantId);
  if (!config) {
    return emptyResult();
  }

  const db = getDb();
  const calendarApi = await getCalendarClient(tenantId);
  const result = emptyResult();
  result.fullResync = !config.syncToken;

  try {
    let nextSyncToken: string | null | undefined;
    try {
      nextSyncToken = await runSingleSyncPass(
        tenantId,
        calendarApi,
        config.googleCalendarId,
        config.syncToken ?? undefined,
        result,
      );
    } catch (error) {
      if (!isSyncTokenInvalidError(error)) throw error;

      // Controlled, bounded full resync: exactly one retry, never an
      // unbounded loop. Reset every counter first — the failed partial
      // pass above may have already processed some events before the
      // token was rejected, and those are re-processed (safely,
      // idempotently) by the full resync below.
      log("calendar.sync.token_invalidated_full_resync", { tenantId });
      Object.assign(result, emptyResult(), { fullResync: true });
      nextSyncToken = await runSingleSyncPass(tenantId, calendarApi, config.googleCalendarId, undefined, result);
    }

    await db
      .update(calendarConnections)
      .set({
        syncToken: nextSyncToken ?? null,
        lastSyncedAt: new Date(),
        lastSyncStatus: "ok",
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(calendarConnections.tenantId, tenantId));

    log("calendar.sync.completed", { tenantId, ...result });
    return result;
  } catch (error) {
    await db
      .update(calendarConnections)
      .set({
        lastSyncStatus: "error",
        lastSyncError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      })
      .where(eq(calendarConnections.tenantId, tenantId));
    captureException(error, "calendar.sync.failed", { tenantId });
    throw error;
  }
}
