import { z } from "zod";

export const selectCalendarSchema = z.object({
  googleCalendarId: z.string().trim().min(1),
  googleCalendarName: z.string().trim().min(1).nullable(),
  timezone: z.string().trim().min(1).nullable(),
});

export type SelectCalendarInput = z.infer<typeof selectCalendarSchema>;

export interface AvailableCalendar {
  id: string;
  name: string;
  timezone: string | null;
  accessRole: string | null;
}

export interface CalendarConfigView {
  configured: boolean;
  googleCalendarId: string | null;
  googleCalendarName: string | null;
  timezone: string | null;
  lastSyncedAt: Date | null;
  lastSyncStatus: "ok" | "error" | null;
  lastSyncError: string | null;
}

export interface CalendarSyncResult {
  eventsSeen: number;
  bookingsCreated: number;
  bookingsUpdated: number;
  bookingsCancelled: number;
  eventsSkippedNoClientData: number;
  eventsIgnoredNotAService: number;
  fullResync: boolean;
}

// ── Pure event parser — never calls Google, never touches the database ──
// Deliberately conservative: every field is null unless confidently
// extractable from real event text. Never guesses a price, a route, a
// phone number, or a name from ambiguous text — an unrecognized event is
// exactly as valid an outcome as a recognized one (see README.md's
// "Recognizing a commercial event" section and TEST 8/13/18's "unrelated
// calendar event -> ignored, no conversion" requirement).

export interface ParsedCalendarEvent {
  // Route, from "Pickup → Destination" or "Pickup -> Destination" anywhere
  // in the event summary — the one structural cue this module imposes,
  // matching the founder's own suggested format. Both null if no arrow is
  // found; never split on anything else (a comma, a dash without spacing,
  // etc. — too ambiguous to trust).
  pickup: string | null;
  destination: string | null;
  // A bare "€<integer>" only (e.g. "€390", "€ 390") — deliberately does
  // NOT attempt to parse "€390,00", "€1.200", or any other separator
  // convention: those are genuinely ambiguous (is "," a decimal mark or a
  // thousands mark? depends on locale) and guessing wrong would silently
  // invent revenue. Ambiguous formats simply extract as null, never a
  // best-effort guess.
  priceCents: number | null;
  // From a "Phone: ..." / "Tel: ..." / "Telefono: ..." line in the
  // description — never guessed from the summary.
  phone: string | null;
  email: string | null;
  gclid: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  // The candidate client name, extracted only from the pipe-delimited
  // format ("TRANSFER | Mario Rossi | Milano → Tirano | €390") — the one
  // segment that isn't the literal "TRANSFER" keyword, isn't the route
  // segment, and isn't the price segment. Null for any other summary
  // shape: a free-text title is not reliably splittable into "a name"
  // without guessing.
  clientName: string | null;
}

const ROUTE_PATTERN = /(.+?)\s*(?:→|->)\s*(.+)/;
const PRICE_PATTERN = /€\s*(\d+)(?!\d*[.,]\d)/;
const PHONE_LINE_PATTERN = /^(?:phone|tel|telefono)\s*:\s*(.+)$/im;
const EMAIL_LINE_PATTERN = /^email\s*:\s*(.+)$/im;
const GCLID_LINE_PATTERN = /^gclid\s*:\s*(.+)$/im;
const UTM_SOURCE_LINE_PATTERN = /^utm[_ ]?source\s*:\s*(.+)$/im;
const UTM_CAMPAIGN_LINE_PATTERN = /^utm[_ ]?campaign\s*:\s*(.+)$/im;

function extractRoute(summary: string): { pickup: string | null; destination: string | null } {
  // Pipe-delimited summaries must isolate just the segment carrying the
  // arrow before matching — otherwise `(.+?)` before the arrow greedily
  // (if lazily) swallows everything to its left, including a leading
  // "TRANSFER | Mario Rossi |" prefix, into the pickup side.
  const routeSegment = summary.includes("|")
    ? (summary.split("|").find((segment) => /(?:→|->)/.test(segment)) ?? summary)
    : summary;

  const match = routeSegment.match(ROUTE_PATTERN);
  if (!match) return { pickup: null, destination: null };
  const pickup = match[1]?.trim();
  // The destination side may still carry a trailing "€390" remainder when
  // the summary isn't pipe-delimited at all (e.g. "Milano → Tirano €390")
  // — strip a trailing price rather than treat it as part of the place name.
  const destination = match[2]
    ?.trim()
    .replace(/€.*$/, "")
    .trim();
  return {
    pickup: pickup || null,
    destination: destination || null,
  };
}

function extractPriceCents(text: string): number | null {
  const match = text.match(PRICE_PATTERN);
  if (!match || !match[1]) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount * 100;
}

function extractLine(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

function extractClientName(summary: string, pickup: string | null, destination: string | null): string | null {
  if (!summary.includes("|")) return null;

  const segments = summary
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

  const candidates = segments.filter((segment) => {
    if (/^transfer$/i.test(segment)) return false;
    if (segment.includes("€")) return false;
    if (pickup && destination && segment.includes(pickup) && segment.includes(destination)) return false;
    if (/(?:→|->)/.test(segment)) return false;
    return true;
  });

  return candidates.length === 1 ? candidates[0]! : null;
}

export function parseCalendarEvent(summary: string, description: string | null): ParsedCalendarEvent {
  const safeSummary = summary ?? "";
  const safeDescription = description ?? "";

  const { pickup, destination } = extractRoute(safeSummary);
  const priceCents = extractPriceCents(safeSummary) ?? extractPriceCents(safeDescription);
  const clientName = extractClientName(safeSummary, pickup, destination);

  return {
    pickup,
    destination,
    priceCents,
    phone: extractLine(safeDescription, PHONE_LINE_PATTERN),
    email: extractLine(safeDescription, EMAIL_LINE_PATTERN),
    gclid: extractLine(safeDescription, GCLID_LINE_PATTERN),
    utmSource: extractLine(safeDescription, UTM_SOURCE_LINE_PATTERN),
    utmCampaign: extractLine(safeDescription, UTM_CAMPAIGN_LINE_PATTERN),
    clientName,
  };
}

// An event only becomes a booking candidate if it carries at least a
// recognizable route (pickup -> destination) — a bare "Dentist
// appointment" or "Lunch with Marco" event on the same calendar is real
// calendar noise, not a service, and must never become a conversion. This
// is deliberately the ONLY gate: which calendar the event lives in (the
// explicitly selected Bonolini calendar) is the primary filter per
// README.md — this is the secondary, structural check against false
// positives within that calendar.
export function isRecognizableService(parsed: ParsedCalendarEvent): boolean {
  return Boolean(parsed.pickup && parsed.destination);
}
