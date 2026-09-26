// Timestamps read through raw SQL (a `sql\`...\`` expression in a select, or
// db.execute) are NOT mapped to Date by drizzle: with postgres-js they come
// back as Postgres' own text, e.g. "2026-09-24 10:15:30.123+00". Only
// columns selected through the query builder are real Dates. Typing such a
// value as Date (sql<Date>) compiles fine and fails at runtime
// ("x.getTime is not a function") — the production bug of 2026-09-24.
//
// toValidDate accepts either shape and returns a valid Date or null, never
// an Invalid Date.

// Postgres timestamptz text: date, space or "T", time with optional
// fraction, offset as "+00", "+0200", "+02:00" or "Z".
const PG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/;

function normalizeOffset(offset: string | undefined): string {
  // No offset only happens for `timestamp without time zone`; every
  // timestamp in this schema is timestamptz, and the database runs in UTC.
  if (!offset || offset === "Z") return "Z";
  const sign = offset[0];
  const digits = offset.slice(1).replace(":", "");
  const hours = digits.slice(0, 2);
  const minutes = digits.slice(2, 4) || "00";
  return `${sign}${hours}:${minutes}`;
}

export function toValidDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;

  const text = value.trim();
  const match = PG_TIMESTAMP.exec(text);
  const date = match ? new Date(`${match[1]}T${match[2]}${normalizeOffset(match[3])}`) : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ── Europe/Rome wall clock ────────────────────────────────────────────────
// Moved from transfer-requests (booking snapshot) on 2026-09-26 so the
// overlap check reads the requested time exactly like the booking does.

export const BOOKING_TIMEZONE = "Europe/Rome";

// How many minutes `timeZone`'s wall clock is ahead of UTC at the instant
// `date` represents (e.g. +60 for Rome in CET, +120 in CEST) — the
// standard Intl-only technique (format `date` in the target zone, re-read
// those wall-clock numbers as if they were UTC, diff against the real UTC
// instant). No new dependency (luxon/date-fns-tz): Node 20's built-in
// full-ICU Intl is already enough, same "don't add a package for what the
// platform already provides" discipline as the rest of this codebase.
function getTimeZoneOffsetMinutes(timeZone: string, date: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    parts.hour === "24" ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - date.getTime()) / 60_000;
}

// requestedDate/requestedTime are the customer's wall-clock request in
// Europe/Rome — Bonolini Transfer's only market — never the server
// process's own timezone. Deliberately NOT shared with
// runAvailabilityForTransferRequest's own (naive, process-timezone)
// candidateStartAt construction above — a founder decision scoped to this
// milestone only, to avoid changing already-shipped, already-tested
// Availability arithmetic; see README.md's "Booking Snapshot" section for
// the known gap this leaves (Availability's feasibility decision and this
// function's scheduledAt can disagree by the CET/CEST offset if the server
// process itself isn't running in Europe/Rome) and why it's accepted for
// now rather than fixed here.
//
// Returns null — never an invented fallback time — when requestedDate/
// requestedTime don't round-trip to a real calendar date/time (e.g. month
// 13, a malformed string).
export function romeWallClockToUtc(requestedDate: string, requestedTime: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(requestedDate);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(requestedTime);
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);

  const provisional = Date.UTC(year, month - 1, day, hour, minute, 0);
  const roundTrip = new Date(provisional);
  const isRealCalendarDateTime =
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day &&
    roundTrip.getUTCHours() === hour &&
    roundTrip.getUTCMinutes() === minute;
  if (!isRealCalendarDateTime) return null;

  const offsetMinutes = getTimeZoneOffsetMinutes(BOOKING_TIMEZONE, roundTrip);
  return new Date(provisional - offsetMinutes * 60_000);
}

function romeParts(date: Date): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: BOOKING_TIMEZONE,
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts;
}

// "14:30" in Europe/Rome.
export function formatRomeTime(date: Date): string {
  const parts = romeParts(date);
  return `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

// "03/10" in Europe/Rome.
export function formatRomeDayMonth(date: Date): string {
  const parts = romeParts(date);
  return `${parts.day}/${parts.month}`;
}
