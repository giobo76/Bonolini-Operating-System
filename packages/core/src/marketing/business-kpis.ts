import { eq } from "drizzle-orm";
import { getDb, clients, quotes, bookings, type Client } from "@bos/db";

// Deliberate, narrow exception to the module-boundary rule in ADR 0002:
// this file runs read-only analytical queries directly against clients/
// quotes/bookings (owned by the clients/quotes/bookings modules) instead of
// going through their routers. Justification: attribution/KPI reporting is
// inherently cross-module, and read-only aggregation carries none of the
// risk direct writes would (a bug here can't corrupt booking/quote state).
// Writes to those tables must still only ever happen through their own
// module's service functions.

function deriveSource(client: Pick<Client, "utmCampaign" | "utmSource" | "gclid">): string {
  if (client.utmCampaign) return client.utmCampaign;
  if (client.utmSource) return client.utmSource;
  if (client.gclid) return "google_ads_untagged";
  return "organic_or_direct";
}

// ── Funnel summary (Click → Lead → Quote → Confirmed → Completed) ───────

export interface FunnelSourceSummary {
  source: string;
  leads: number;
  quotes: number;
  quotesAccepted: number;
  bookingsConfirmed: number;
  bookingsCompleted: number;
  bookingsCancelled: number;
}

export interface FunnelSummary {
  bySource: FunnelSourceSummary[];
  overall: FunnelSourceSummary;
}

function emptySummary(source: string): FunnelSourceSummary {
  return {
    source,
    leads: 0,
    quotes: 0,
    quotesAccepted: 0,
    bookingsConfirmed: 0,
    bookingsCompleted: 0,
    bookingsCancelled: 0,
  };
}

export async function getFunnelSummary(tenantId: string): Promise<FunnelSummary> {
  const db = getDb();
  const [allClients, allQuotes, allBookings] = await Promise.all([
    db.select().from(clients).where(eq(clients.tenantId, tenantId)),
    db.select().from(quotes).where(eq(quotes.tenantId, tenantId)),
    db.select().from(bookings).where(eq(bookings.tenantId, tenantId)),
  ]);

  const sourceByClientId = new Map(allClients.map((c) => [c.id, deriveSource(c)]));
  const bucket = new Map<string, FunnelSourceSummary>();
  const getBucket = (source: string) => {
    let entry = bucket.get(source);
    if (!entry) {
      entry = emptySummary(source);
      bucket.set(source, entry);
    }
    return entry;
  };

  for (const client of allClients) {
    getBucket(deriveSource(client)).leads += 1;
  }

  for (const quote of allQuotes) {
    const source = sourceByClientId.get(quote.clientId);
    if (!source) continue;
    const entry = getBucket(source);
    entry.quotes += 1;
    if (quote.status === "accepted") entry.quotesAccepted += 1;
  }

  for (const booking of allBookings) {
    const source = sourceByClientId.get(booking.clientId);
    if (!source) continue;
    const entry = getBucket(source);
    // A completed booking was confirmed at some point too — "confirmed"
    // here means "ever confirmed," a distinct funnel stage from "completed."
    if (booking.status === "confirmed" || booking.status === "completed") {
      entry.bookingsConfirmed += 1;
    }
    if (booking.status === "completed") entry.bookingsCompleted += 1;
    if (booking.status === "cancelled") entry.bookingsCancelled += 1;
  }

  const bySource = Array.from(bucket.values()).sort((a, b) => b.leads - a.leads);

  const overall = bySource.reduce<FunnelSourceSummary>((acc, entry) => {
    acc.leads += entry.leads;
    acc.quotes += entry.quotes;
    acc.quotesAccepted += entry.quotesAccepted;
    acc.bookingsConfirmed += entry.bookingsConfirmed;
    acc.bookingsCompleted += entry.bookingsCompleted;
    acc.bookingsCancelled += entry.bookingsCancelled;
    return acc;
  }, emptySummary("overall"));

  return { bySource, overall };
}

// ── Conversion rates ─────────────────────────────────────────────────────
// null (not 0) when there isn't enough data yet — a 0% rate and "no data"
// are different facts and shouldn't be presented the same way.

export interface ConversionRates {
  quoteAcceptanceRate: number | null;
  depositConversionRate: number | null;
  bookingCompletionRate: number | null;
  returnCustomerRate: number | null;
}

export async function getConversionRates(tenantId: string): Promise<ConversionRates> {
  const db = getDb();
  const [allQuotes, allBookings] = await Promise.all([
    db.select().from(quotes).where(eq(quotes.tenantId, tenantId)),
    db.select().from(bookings).where(eq(bookings.tenantId, tenantId)),
  ]);

  const respondedQuotes = allQuotes.filter((q) => q.status === "accepted" || q.status === "declined");
  const acceptedQuotes = allQuotes.filter((q) => q.status === "accepted");

  const confirmedOrCompleted = allBookings.filter(
    (b) => b.status === "confirmed" || b.status === "completed",
  );
  const withDeposit = confirmedOrCompleted.filter((b) => b.depositPaidAt != null);
  const completed = allBookings.filter((b) => b.status === "completed");

  const bookingCountByClient = new Map<string, number>();
  for (const booking of confirmedOrCompleted) {
    bookingCountByClient.set(booking.clientId, (bookingCountByClient.get(booking.clientId) ?? 0) + 1);
  }
  const clientsWithBookings = bookingCountByClient.size;
  const returningClients = Array.from(bookingCountByClient.values()).filter((n) => n > 1).length;

  return {
    quoteAcceptanceRate: respondedQuotes.length
      ? acceptedQuotes.length / respondedQuotes.length
      : null,
    depositConversionRate: confirmedOrCompleted.length
      ? withDeposit.length / confirmedOrCompleted.length
      : null,
    bookingCompletionRate: confirmedOrCompleted.length
      ? completed.length / confirmedOrCompleted.length
      : null,
    returnCustomerRate: clientsWithBookings ? returningClients / clientsWithBookings : null,
  };
}

// ── Revenue and LTV by acquisition source ────────────────────────────────
// Money in cents throughout, per docs/engineering/02-coding-standards.md.

export interface RevenueSourceEntry {
  source: string;
  revenueCents: number;
  bookingCount: number;
}

export async function getRevenueBySource(tenantId: string): Promise<RevenueSourceEntry[]> {
  const db = getDb();
  const [allClients, allBookings] = await Promise.all([
    db.select().from(clients).where(eq(clients.tenantId, tenantId)),
    db.select().from(bookings).where(eq(bookings.tenantId, tenantId)),
  ]);

  const sourceByClientId = new Map(allClients.map((c) => [c.id, deriveSource(c)]));
  const bucket = new Map<string, RevenueSourceEntry>();

  for (const booking of allBookings) {
    if (booking.status === "cancelled") continue;
    const source = sourceByClientId.get(booking.clientId);
    if (!source) continue;
    let entry = bucket.get(source);
    if (!entry) {
      entry = { source, revenueCents: 0, bookingCount: 0 };
      bucket.set(source, entry);
    }
    entry.revenueCents += booking.paidAmountCents ?? booking.finalAmountCents ?? 0;
    entry.bookingCount += 1;
  }

  return Array.from(bucket.values()).sort((a, b) => b.revenueCents - a.revenueCents);
}

export interface LtvSourceEntry {
  source: string;
  clientCount: number;
  totalRevenueCents: number;
  averageRevenueCents: number;
}

export async function getLtvBySource(tenantId: string): Promise<LtvSourceEntry[]> {
  const db = getDb();
  const [allClients, allBookings] = await Promise.all([
    db.select().from(clients).where(eq(clients.tenantId, tenantId)),
    db.select().from(bookings).where(eq(bookings.tenantId, tenantId)),
  ]);

  const revenueByClientId = new Map<string, number>();
  for (const booking of allBookings) {
    if (booking.status === "cancelled") continue;
    const revenue = booking.paidAmountCents ?? booking.finalAmountCents ?? 0;
    revenueByClientId.set(booking.clientId, (revenueByClientId.get(booking.clientId) ?? 0) + revenue);
  }

  const bucket = new Map<string, { clientCount: number; totalRevenueCents: number }>();
  for (const client of allClients) {
    const source = deriveSource(client);
    const revenue = revenueByClientId.get(client.id) ?? 0;
    let entry = bucket.get(source);
    if (!entry) {
      entry = { clientCount: 0, totalRevenueCents: 0 };
      bucket.set(source, entry);
    }
    entry.clientCount += 1;
    entry.totalRevenueCents += revenue;
  }

  return Array.from(bucket.entries())
    .map(([source, { clientCount, totalRevenueCents }]) => ({
      source,
      clientCount,
      totalRevenueCents,
      averageRevenueCents: clientCount ? Math.round(totalRevenueCents / clientCount) : 0,
    }))
    .sort((a, b) => b.averageRevenueCents - a.averageRevenueCents);
}

// ── Cost-per-stage (NOT wired to tRPC yet) ───────────────────────────────
// Real ad spend must come from the Google Ads API, which isn't integrated
// yet (still pending from MIE-2's original monitoring scope). This
// function is complete and correct — it takes spend as an explicit
// parameter rather than fabricating a number — but has no real caller
// supplying spendBySourceCents yet, so it isn't exposed via the router
// until that integration exists. See packages/core/src/marketing/README.md.

export interface CostPerStageEntry {
  source: string;
  spendCents: number;
  costPerLeadCents: number | null;
  costPerQuoteCents: number | null;
  costPerConfirmedBookingCents: number | null;
  costPerCompletedServiceCents: number | null;
}

export async function getCostPerStageBySource(
  tenantId: string,
  spendBySourceCents: Record<string, number>,
): Promise<CostPerStageEntry[]> {
  const { bySource } = await getFunnelSummary(tenantId);

  const perUnit = (spendCents: number, count: number) =>
    count > 0 && spendCents > 0 ? Math.round(spendCents / count) : null;

  return bySource.map((entry) => {
    const spendCents = spendBySourceCents[entry.source] ?? 0;
    return {
      source: entry.source,
      spendCents,
      costPerLeadCents: perUnit(spendCents, entry.leads),
      costPerQuoteCents: perUnit(spendCents, entry.quotes),
      costPerConfirmedBookingCents: perUnit(spendCents, entry.bookingsConfirmed),
      costPerCompletedServiceCents: perUnit(spendCents, entry.bookingsCompleted),
    };
  });
}
