import { z } from "zod";
import type { Booking, TransferRequest } from "@bos/db";
import {
  computeServiceBusyWindow,
  findOverlaps,
  fromStoredBusyWindow,
  storedBusyWindowSchema,
  toStoredBusyWindow,
  FALLBACK_BUSY_MINUTES,
  type StoredBusyWindow,
  type TimeWindow,
} from "../availability";
import { listActiveBookingsBetween } from "../bookings";
import { isBosEventId, listCalendarBusyEvents } from "../calendar";
import { getClient } from "../clients";
import { romeWallClockToUtc } from "../dates";

// The "Disponibilità" of a PREVENTIVO PRONTO round (founder decisions
// 2026-09-26): the request's busy window compared with the BOS bookings and
// the Google Calendar events around it. Never blocks anything: the result
// is only shown to the founder, who decides.

const HOUR_MS = 3_600_000;
// A booking's busy window starts before its pickup (the drive from
// Sondrio) and lasts hours: look at pickups from a day before the request
// to half a day after it.
const BOOKINGS_BEFORE_MS = 24 * HOUR_MS;
const BOOKINGS_AFTER_MS = 12 * HOUR_MS;

const overlapEntrySchema = z.object({
  kind: z.enum(["booking", "calendar_event"]),
  startAt: z.string(),
  endAt: z.string(),
  durationToVerify: z.boolean(),
  clientName: z.string().nullable().optional(),
  pickup: z.string().nullable().optional(),
  destination: z.string().nullable().optional(),
  pickupAt: z.string().nullable().optional(),
  bookingStatus: z.string().optional(),
  ref: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  allDay: z.boolean().optional(),
});
export type OverlapEntry = z.infer<typeof overlapEntrySchema>;

export const availabilityCheckSchema = z.object({
  checkedAt: z.string(),
  candidate: storedBusyWindowSchema.nullable(),
  overlaps: z.array(overlapEntrySchema),
  bookingsChecked: z.number(),
  calendarChecked: z.boolean(),
  // Why the check is incomplete ("Disponibilità: NON verificata (…)").
  notVerifiedReasons: z.array(z.string()),
});
export type AvailabilityCheck = z.infer<typeof availabilityCheckSchema>;

export function parseAvailabilityCheck(value: unknown): AvailabilityCheck | null {
  const parsed = availabilityCheckSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function notVerified(reason: string): AvailabilityCheck {
  return {
    checkedAt: new Date().toISOString(),
    candidate: null,
    overlaps: [],
    bookingsChecked: 0,
    calendarChecked: false,
    notVerifiedReasons: [reason],
  };
}

function bookingWindow(booking: Booking): (TimeWindow & { durationToVerify: boolean; booking: Booking }) | null {
  const stored = fromStoredBusyWindow(booking.busyWindow);
  if (stored) return { startAt: stored.startAt, endAt: stored.endAt, durationToVerify: stored.durationToVerify, booking };
  if (!booking.scheduledAt) return null;
  // Created before busy windows were stored: pickup + 2 hours, to verify.
  return {
    startAt: booking.scheduledAt,
    endAt: new Date(booking.scheduledAt.getTime() + FALLBACK_BUSY_MINUTES * 60_000),
    durationToVerify: true,
    booking,
  };
}

export async function runAvailabilityCheck(tenantId: string, tr: TransferRequest): Promise<AvailabilityCheck> {
  const pickupAt =
    tr.requestedDate && tr.requestedTime ? romeWallClockToUtc(tr.requestedDate, tr.requestedTime) : null;
  if (!pickupAt) return notVerified("data o ora della richiesta non leggibili");

  const candidate = await computeServiceBusyWindow(tenantId, { pickup: tr.pickup, destination: tr.destination, pickupAt });
  const reasons: string[] = [];

  const calendar = await listCalendarBusyEvents(tenantId, candidate.startAt, candidate.endAt);
  if (calendar.status === "not_connected") reasons.push("Google Calendar non collegato nel pannello");
  if (calendar.status === "error") reasons.push(`Google Calendar non leggibile: ${calendar.message}`);
  const calendarChecked = calendar.status === "ok";

  const bookings = (
    await listActiveBookingsBetween(
      tenantId,
      new Date(candidate.startAt.getTime() - BOOKINGS_BEFORE_MS),
      new Date(candidate.endAt.getTime() + BOOKINGS_AFTER_MS),
    )
  ).filter((booking) => booking.transferRequestId !== tr.id);

  // A booking imported from Google Calendar is compared through its event
  // (with the duration the founder gave it) when the calendar was read.
  const comparable = bookings.filter(
    (booking) => !(calendarChecked && booking.calendarEventId && !isBosEventId(booking.calendarEventId)),
  );
  const windows = comparable.map(bookingWindow).filter((w): w is NonNullable<typeof w> => w !== null);

  const overlaps: OverlapEntry[] = [];
  for (const hit of findOverlaps(candidate, windows)) {
    const client = await getClient(tenantId, hit.booking.clientId);
    overlaps.push({
      kind: "booking",
      startAt: hit.startAt.toISOString(),
      endAt: hit.endAt.toISOString(),
      durationToVerify: hit.durationToVerify,
      clientName: client?.fullName ?? null,
      pickup: hit.booking.pickup,
      destination: hit.booking.destination,
      pickupAt: hit.booking.scheduledAt?.toISOString() ?? null,
      bookingStatus: hit.booking.status,
      ref: hit.booking.transferRequestId ? `#${hit.booking.transferRequestId.slice(0, 6)}` : null,
    });
  }
  if (calendar.status === "ok") {
    for (const event of findOverlaps(candidate, calendar.events)) {
      overlaps.push({
        kind: "calendar_event",
        startAt: event.startAt.toISOString(),
        endAt: event.endAt.toISOString(),
        durationToVerify: false,
        summary: event.summary,
        allDay: event.allDay,
      });
    }
  }
  overlaps.sort((a, b) => a.startAt.localeCompare(b.startAt));

  const stored: StoredBusyWindow = toStoredBusyWindow(candidate);
  return {
    checkedAt: new Date().toISOString(),
    candidate: stored,
    overlaps,
    bookingsChecked: bookings.length,
    calendarChecked,
    notVerifiedReasons: reasons,
  };
}
