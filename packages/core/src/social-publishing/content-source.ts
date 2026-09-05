import { and, eq, gte, or } from "drizzle-orm";
import { getDb, bookings } from "@bos/db";

// Deliberate, narrow exception to the module-boundary rule in ADR 0002 —
// same justification as packages/core/src/marketing/business-kpis.ts: this
// runs a read-only analytical query directly against bookings (owned by the
// bookings module) instead of going through its router. A bug here can
// never corrupt booking state; it can only ever produce a thinner post.
//
// Only bookings.pickup/bookings.destination are read — these are always the
// generalized place/city-level route fields (e.g. "Milano", "Tirano"), never
// bookings.pickupAddress/destinationAddress, which hold full street
// addresses. This is a structural guarantee, not a filter applied after the
// fact: the SELECT below never lists the address columns at all.

export interface ServedRoute {
  pickup: string;
  destination: string;
}

// Deterministic, keyword-based classification of a real route into a coarse
// transfer type — not an invented fact, a pattern match over the real
// pickup/destination text (same spirit as calendar/schema.ts's
// parseCalendarEvent: a transform of real data, never a guess at data that
// isn't there). No vehicle/service-type column exists anywhere in BOS today
// (see packages/core/src/drivers/README.md — not built yet), so this is the
// only "transfer type" signal genuinely available.
export type TransferTypeLabel = "airport transfer" | "regional transfer";

const AIRPORT_KEYWORDS = [
  "malpensa",
  "linate",
  "orio al serio",
  "bergamo airport",
  "aeroporto",
  "airport",
  "mxp",
  "bgy",
  "lin",
];

export function classifyTransferType(pickup: string, destination: string): TransferTypeLabel {
  const haystack = `${pickup} ${destination}`.toLowerCase();
  return AIRPORT_KEYWORDS.some((keyword) => haystack.includes(keyword)) ? "airport transfer" : "regional transfer";
}

export interface RealPostDataSnapshot {
  servedRoutes: ServedRoute[];
  transferTypes: TransferTypeLabel[];
  serviceAreaPlaces: string[];
  windowDays: number;
}

// 90 days: wide enough that a genuinely low-volume business still has real
// routes to draw from most weeks, narrow enough that "recently served"
// stays honest. Not tied to any founder-specified number — a judgment call,
// flagged as such.
const LOOKBACK_DAYS = 90;

export async function getRealPostDataSnapshot(tenantId: string): Promise<RealPostDataSnapshot> {
  const db = getDb();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({ pickup: bookings.pickup, destination: bookings.destination })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        or(eq(bookings.status, "confirmed"), eq(bookings.status, "completed")),
        gte(bookings.createdAt, since),
      ),
    );

  const seenRoutes = new Set<string>();
  const servedRoutes: ServedRoute[] = [];
  const placeSet = new Set<string>();
  const typeSet = new Set<TransferTypeLabel>();

  for (const row of rows) {
    // A booking created outside ensureBookingForApprovedTransferRequest/
    // ensureBookingFromCalendarEvent (the plain admin createBooking path)
    // may have null pickup/destination — never invent a route to fill the
    // gap, just skip it.
    if (!row.pickup || !row.destination) continue;

    const routeKey = `${row.pickup}→${row.destination}`;
    if (seenRoutes.has(routeKey)) continue;
    seenRoutes.add(routeKey);

    servedRoutes.push({ pickup: row.pickup, destination: row.destination });
    placeSet.add(row.pickup);
    placeSet.add(row.destination);
    typeSet.add(classifyTransferType(row.pickup, row.destination));
  }

  return {
    servedRoutes,
    transferTypes: Array.from(typeSet),
    serviceAreaPlaces: Array.from(placeSet).sort(),
    windowDays: LOOKBACK_DAYS,
  };
}

// A week with zero real, recognizable routes has nothing genuine to write
// about — the only correct behavior is to skip the post entirely, never to
// pad it out with an invented route or a generic claim. Exported so
// service.ts's "no data this week" branch is directly testable.
export function hasEnoughDataForPost(snapshot: RealPostDataSnapshot): boolean {
  return snapshot.servedRoutes.length > 0;
}
