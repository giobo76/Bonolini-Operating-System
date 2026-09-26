import { getCalendarClient } from "../marketing";
import { getClient } from "../clients";
import { getBooking, attachCalendarEventToBooking } from "../bookings";
import { getTransferRequest } from "../transfer-requests";
import { computeServiceBusyWindow, fromStoredBusyWindow } from "../availability";
import { log, captureException } from "../observability";
import { getCalendarConnectionRow } from "./service";
import { bosEventIdForBooking } from "./schema";
import {
  buildBookingEventDescription,
  buildBookingEventTitle,
  cancelledTitle,
  CANCELLED_COLOR_ID,
} from "./booking-event-content";

// The one write path to Google Calendar (founder decisions 2026-09-25):
// events.insert when a booking is confirmed (after the deposit, or after
// "Confermato dal cliente" for an italian customer),
// events.get + events.patch ("ANNULLATO", grey) when it is cancelled in BOS.
// Never events.delete, never an event BOS did not create. See README.md.

const EVENT_TIMEZONE = "Europe/Rome";

export type CreateBookingEventOutcome =
  | "created"
  | "already_exists"
  | "skipped_not_found"
  | "skipped_not_confirmed"
  | "skipped_no_transfer_request"
  | "skipped_has_event"
  | "skipped_no_schedule"
  | "skipped_no_calendar";

export type CancelBookingEventOutcome =
  | "marked_cancelled"
  | "already_marked"
  | "skipped_not_found"
  | "skipped_not_cancelled"
  | "skipped_not_bos_event"
  | "skipped_no_calendar"
  | "skipped_no_event";

function httpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: number | string; status?: number; response?: { status?: number } };
  const status = value.response?.status ?? value.status ?? Number(value.code);
  return Number.isFinite(status) ? Number(status) : null;
}

export async function createCalendarEventForBooking(tenantId: string, bookingId: string): Promise<CreateBookingEventOutcome> {
  const booking = await getBooking(tenantId, bookingId);
  if (!booking) return "skipped_not_found";
  if (booking.status !== "confirmed") return "skipped_not_confirmed";
  if (!booking.transferRequestId) return "skipped_no_transfer_request";
  // Came from Google Calendar in the first place, or already has its event.
  if (booking.calendarEventId) return "skipped_has_event";
  if (!booking.scheduledAt || booking.finalAmountCents === null) {
    captureException(new Error("booking without date or price: no calendar event"), "calendar.booking_event.incomplete_booking", {
      tenantId,
      bookingId,
    });
    return "skipped_no_schedule";
  }

  const connection = await getCalendarConnectionRow(tenantId);
  if (!connection) {
    log("calendar.booking_event.no_calendar", { tenantId, bookingId });
    return "skipped_no_calendar";
  }

  const [tr, client] = await Promise.all([
    getTransferRequest(tenantId, booking.transferRequestId),
    getClient(tenantId, booking.clientId),
  ]);
  const pickup = booking.pickup ?? tr?.pickup ?? null;
  const destination = booking.destination ?? tr?.destination ?? null;

  // The window the overlap check used, stored at Approva; computed here
  // only for a booking that has none.
  const window =
    fromStoredBusyWindow(booking.busyWindow) ??
    (await computeServiceBusyWindow(tenantId, { pickup, destination, pickupAt: booking.scheduledAt }));

  const clientName = client?.fullName ?? "Cliente";
  const route = { pickup: pickup ?? "?", destination: destination ?? "?" };
  const eventId = bosEventIdForBooking(booking.id);
  const requestBody = {
    id: eventId,
    summary: buildBookingEventTitle({ clientName, ...route, totalCents: booking.finalAmountCents, currency: booking.currency }),
    description: buildBookingEventDescription({
      transferRequestRef: `#${booking.transferRequestId.slice(0, 6)}`,
      clientName,
      clientPhone: client?.phone ?? "",
      ...route,
      requestedDate: tr?.requestedDate ?? null,
      requestedTime: tr?.requestedTime ?? null,
      passengers: tr?.passengers ?? null,
      children: tr?.children ?? null,
      childrenAges: tr?.childrenAges ?? null,
      luggage: tr?.luggage ?? null,
      flightNumber: tr?.flightNumber ?? null,
      trainNumber: tr?.trainNumber ?? null,
      hotel: tr?.hotel ?? null,
      totalCents: booking.finalAmountCents,
      depositCents: booking.depositAmountCents,
      currency: booking.currency,
      loopLabel: window.loopLabel,
      loopMinutes: window.loopMinutes,
      window,
      mapsUnavailable: window.mapsUnavailable,
    }),
    location: pickup ?? undefined,
    start: { dateTime: window.startAt.toISOString(), timeZone: EVENT_TIMEZONE },
    end: { dateTime: window.endAt.toISOString(), timeZone: EVENT_TIMEZONE },
    extendedProperties: { private: { bosBookingId: booking.id } },
  };

  const calendarApi = await getCalendarClient(tenantId);
  let outcome: CreateBookingEventOutcome = "created";
  try {
    await calendarApi.events.insert({ calendarId: connection.googleCalendarId, requestBody });
  } catch (error) {
    // Same id already inserted (a retry after a crash): never a second event.
    if (httpStatus(error) !== 409) throw error;
    outcome = "already_exists";
  }

  await attachCalendarEventToBooking(tenantId, booking.id, eventId);
  log("calendar.booking_event.created", { tenantId, bookingId, eventId, outcome, durationToVerify: window.durationToVerify });

  // Cancelled while the event was being created: the cancellation handler
  // may have found no event yet, so mark it here.
  const latest = await getBooking(tenantId, booking.id);
  if (latest?.status === "cancelled") await markCalendarEventCancelledForBooking(tenantId, booking.id);

  return outcome;
}

export async function markCalendarEventCancelledForBooking(tenantId: string, bookingId: string): Promise<CancelBookingEventOutcome> {
  const booking = await getBooking(tenantId, bookingId);
  if (!booking) return "skipped_not_found";
  if (booking.status !== "cancelled") return "skipped_not_cancelled";

  const eventId = bosEventIdForBooking(booking.id);
  // An event the founder created himself (booking imported from Calendar)
  // is never modified by BOS.
  if (booking.calendarEventId && booking.calendarEventId !== eventId) return "skipped_not_bos_event";

  const connection = await getCalendarConnectionRow(tenantId);
  if (!connection) return "skipped_no_calendar";

  const calendarApi = await getCalendarClient(tenantId);
  let current: { summary?: string | null; status?: string | null; colorId?: string | null };
  try {
    const response = await calendarApi.events.get({ calendarId: connection.googleCalendarId, eventId });
    current = response.data;
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404 || status === 410) return "skipped_no_event";
    throw error;
  }
  // Deleted by hand in Google: nothing to mark.
  if (current.status === "cancelled") return "skipped_no_event";

  const summary = cancelledTitle(current.summary);
  if (summary === current.summary && current.colorId === CANCELLED_COLOR_ID) return "already_marked";

  await calendarApi.events.patch({
    calendarId: connection.googleCalendarId,
    eventId,
    requestBody: { summary, colorId: CANCELLED_COLOR_ID },
  });
  log("calendar.booking_event.marked_cancelled", { tenantId, bookingId, eventId });
  return "marked_cancelled";
}
