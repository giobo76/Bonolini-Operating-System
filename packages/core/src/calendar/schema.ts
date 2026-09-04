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
  // Route. Two recognized, mutually-exclusive formats, tried in order:
  // (1) "Pickup → Destination" / "Pickup -> Destination" anywhere in the
  //     summary — the founder's own originally-suggested format.
  // (2) "(Pickup - Destination)" — a place name, a single space-hyphen-
  //     space, another place name, inside parentheses — the format
  //     actually already in use across the founder's real, pre-existing
  //     calendar events (verified directly against real Production
  //     events during the 2026-09-04 diagnosis: "Servizio Mario (Milano
  //     Duomo - Tirano)", "(MXP T1 - Morbegno)", etc. — none of them used
  //     the arrow). Guarded against a time range read as a route (e.g.
  //     "(arrivo entro 09:00 - 09:15)") by rejecting either side if it
  //     looks like a clock time (`H:MM` or `HH:MM`).
  // Both null if neither format matches; never split on a bare comma or
  // an unspaced dash — too ambiguous to trust.
  pickup: string | null;
  destination: string | null;
  // A bare "€<integer>" only (e.g. "€390", "€ 390") — deliberately does
  // NOT attempt to parse "€390,00", "€1.200", or any other separator
  // convention: those are genuinely ambiguous (is "," a decimal mark or a
  // thousands mark? depends on locale) and guessing wrong would silently
  // invent revenue. Ambiguous formats simply extract as null, never a
  // best-effort guess.
  priceCents: number | null;
  // From "Phone:"/"Tel:"/"Telefono:" anywhere in the description (not
  // anchored to the start of a line — verified against real Production
  // events on 2026-09-04: the founder's actual format embeds it mid-
  // sentence, e.g. "Cliente: Mario (Tel: +1 (909) 282-7598) Pick-up:
  // ..." on one single line, never one field per line). Captures a
  // phone-number-shaped token (digits/spaces/+/-/parens, 5-21 chars) so a
  // US-style area-code paren inside the number itself doesn't truncate
  // the match. When a description carries more than one phone (e.g. an
  // intermediary's and the passenger's), the first one found wins — a
  // documented, deterministic tie-break, never a semantic guess at which
  // one is "the real customer."
  phone: string | null;
  email: string | null;
  gclid: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  // The candidate client name — from the pipe-delimited format
  // ("TRANSFER | Mario Rossi | Milano → Tirano | €390"), or from a
  // "Passeggero:"/"Cliente:"/"Passenger:"/"Client:" label in the
  // description (verified against real Production events: "Passeggero:
  // ALESSANDRO VOLA (Tel: ...)" — deliberately not "Commitgente:", which
  // in the founder's real events names an intermediary/booking agent,
  // not the actual customer). Null for any other summary/description
  // shape: free text is not reliably splittable into "a name" without
  // guessing.
  clientName: string | null;
}

const ARROW_ROUTE_PATTERN = /(.+?)\s*(?:→|->)\s*(.+)/;
const PAREN_ROUTE_PATTERN = /\(([^()]+?)\s-\s([^()]+?)\)/;
const TIME_LIKE_PATTERN = /^\d{1,2}:\d{2}/;
const PRICE_PATTERN = /€\s*(\d+)(?!\d*[.,]\d)/;
const PHONE_PATTERN = /(?:phone|tel|telefono)\s*:\s*([+\d][\d\s\-()]{3,19}\d)/i;
const EMAIL_PATTERN = /email\s*:\s*(\S+@\S+)/i;
const GCLID_PATTERN = /gclid\s*:\s*(\S+)/i;
const UTM_SOURCE_PATTERN = /utm[_ ]?source\s*:\s*(\S+)/i;
const UTM_CAMPAIGN_PATTERN = /utm[_ ]?campaign\s*:\s*(\S+)/i;
const NAME_LABEL_PATTERN = /(?:passeggero|cliente|passenger|client)\s*:\s*([A-Za-zÀ-ÖØ-öø-ÿ' ]+?)(?=\s*[(\n]|\s*$|,\s*\d)/i;

function extractRoute(summary: string): { pickup: string | null; destination: string | null } {
  // Pipe-delimited summaries must isolate just the segment carrying the
  // arrow before matching — otherwise `(.+?)` before the arrow greedily
  // (if lazily) swallows everything to its left, including a leading
  // "TRANSFER | Mario Rossi |" prefix, into the pickup side.
  const routeSegment = summary.includes("|")
    ? (summary.split("|").find((segment) => /(?:→|->)/.test(segment)) ?? summary)
    : summary;

  const arrowMatch = routeSegment.match(ARROW_ROUTE_PATTERN);
  if (arrowMatch) {
    const pickup = arrowMatch[1]?.trim();
    // The destination side may still carry a trailing "€390" remainder
    // when the summary isn't pipe-delimited at all (e.g. "Milano →
    // Tirano €390") — strip a trailing price rather than treat it as
    // part of the place name.
    const destination = arrowMatch[2]
      ?.trim()
      .replace(/€.*$/, "")
      .trim();
    if (pickup && destination) return { pickup, destination };
  }

  const parenMatch = summary.match(PAREN_ROUTE_PATTERN);
  if (parenMatch) {
    const left = parenMatch[1]!.trim();
    const right = parenMatch[2]!.trim();
    if (left && right && !TIME_LIKE_PATTERN.test(left) && !TIME_LIKE_PATTERN.test(right)) {
      return { pickup: left, destination: right };
    }
  }

  return { pickup: null, destination: null };
}

function extractPriceCents(text: string): number | null {
  const match = text.match(PRICE_PATTERN);
  if (!match || !match[1]) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount * 100;
}

function extractFirst(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

function extractClientName(
  summary: string,
  description: string,
  pickup: string | null,
  destination: string | null,
): string | null {
  const fromDescription = extractFirst(description, NAME_LABEL_PATTERN);
  if (fromDescription) return fromDescription;

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
  const clientName = extractClientName(safeSummary, safeDescription, pickup, destination);

  return {
    pickup,
    destination,
    priceCents,
    phone: extractFirst(safeDescription, PHONE_PATTERN),
    email: extractFirst(safeDescription, EMAIL_PATTERN),
    gclid: extractFirst(safeDescription, GCLID_PATTERN),
    utmSource: extractFirst(safeDescription, UTM_SOURCE_PATTERN),
    utmCampaign: extractFirst(safeDescription, UTM_CAMPAIGN_PATTERN),
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
