import { Param, StringChunk } from "drizzle-orm";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RouteDistanceResult } from "../maps-distance";

// ── Deal layer integration (Phase 2.5) ────────────────────────────────────
// Exercises the REAL production functions across transfer-requests, deals,
// quotes, bookings and pricing — composed exactly as the live WhatsApp
// webhook composes them (processTransferRequestForMessageAndPrice), never
// reimplemented here. Only @bos/db and the two Maps wrappers are faked.
//
// Unlike whatsapp-pricing-simulation.integration.test.ts, this file's mock
// performs REAL filtering/sorting (not the "ignore the where condition"
// simplification the other two @bos/db mocks in this codebase use) —
// several scenarios below genuinely need it: multiple transfer_requests
// under one deal, two simultaneously active deals for the same client,
// disambiguation by route.
//
// The 9-message sequence in "the real production incident" below
// reproduces, message for message, the actual case verified read-only
// against Production on 2026-09-18 (client phone +91...11, route Grand
// Hotel Menaggio -> Tirano Station, 20/09/2026 11:00) — see the read-only
// diagnosis and the Phase 2.5 design document this test proves. Every
// pickup/destination/intent value below is taken directly from that
// verified data, not invented for this test.

const {
  fakeState,
  tenantsTable,
  clientsTable,
  whatsappMessagesTable,
  transferRequestsTable,
  dealsTable,
  quotesTable,
  bookingsTable,
  businessRulesTable,
  businessRuleVersionsTable,
  businessRuleVersionEvidenceTable,
  evidenceTable,
} = vi.hoisted(() => {
  return {
    fakeState: {
      tenant: { id: "tenant-real-1", slug: "bonolini-transfer" },
      clients: [] as Array<Record<string, unknown>>,
      whatsappMessages: [] as Array<Record<string, unknown>>,
      transferRequests: [] as Array<Record<string, unknown>>,
      deals: [] as Array<Record<string, unknown>>,
      quotes: [] as Array<Record<string, unknown>>,
      bookings: [] as Array<Record<string, unknown>>,
      businessRules: [] as Array<Record<string, unknown>>,
      businessRuleVersions: [] as Array<Record<string, unknown>>,
      businessRuleVersionEvidence: [] as Array<Record<string, unknown>>,
      evidence: [] as Array<Record<string, unknown>>,
      nextRequestId: 1,
      nextDealId: 1,
      nextQuoteId: 1,
      nextBookingId: 1,
      nextMessageId: 1,
    },
    tenantsTable: { __name: "tenants" },
    clientsTable: { __name: "clients" },
    whatsappMessagesTable: { __name: "whatsappMessages" },
    transferRequestsTable: { __name: "transferRequests" },
    dealsTable: { __name: "deals" },
    quotesTable: { __name: "quotes" },
    bookingsTable: { __name: "bookings" },
    businessRulesTable: { __name: "businessRules" },
    businessRuleVersionsTable: { __name: "businessRuleVersions" },
    businessRuleVersionEvidenceTable: { __name: "businessRuleVersionEvidence" },
    evidenceTable: { __name: "evidence" },
  };
});

function sourceFor(table: unknown): Array<Record<string, unknown>> {
  if (table === clientsTable) return fakeState.clients;
  if (table === whatsappMessagesTable) return fakeState.whatsappMessages;
  if (table === transferRequestsTable) return fakeState.transferRequests;
  if (table === dealsTable) return fakeState.deals;
  if (table === quotesTable) return fakeState.quotes;
  if (table === bookingsTable) return fakeState.bookings;
  if (table === businessRulesTable) return fakeState.businessRules;
  if (table === businessRuleVersionsTable) return fakeState.businessRuleVersions;
  if (table === businessRuleVersionEvidenceTable) return fakeState.businessRuleVersionEvidence;
  if (table === evidenceTable) return fakeState.evidence;
  return [];
}

function sortFieldFor(table: unknown): string | undefined {
  if (table === transferRequestsTable) return "createdAt";
  if (table === dealsTable) return "lastMessageAt";
  return undefined;
}

// Recursive eq()-value extraction — see deals/service.test.ts's own
// identical helper for why this needs to recurse (and(eq(...), eq(...))
// nests each eq()'s SQL object one level inside the outer and()'s
// queryChunks rather than flattening them).
function extractEqValues(condition: unknown): string[] {
  if (!condition || typeof condition !== "object" || !("queryChunks" in condition)) return [];
  const chunks = (condition as { queryChunks: unknown[] }).queryChunks;
  const values: string[] = [];
  for (const chunk of chunks) {
    if (chunk instanceof StringChunk) continue;
    if (chunk instanceof Param) {
      if (typeof chunk.value === "string") values.push(chunk.value);
      continue;
    }
    if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
      values.push(...extractEqValues(chunk));
      continue;
    }
    if (typeof chunk === "string") values.push(chunk);
  }
  return values;
}

function matchesCondition(row: Record<string, unknown>, values: string[]): boolean {
  return values.length > 0 && values.every((value) => Object.values(row).includes(value));
}

function thenable(rows: Array<Record<string, unknown>>, sortField?: string) {
  const sorted = sortField
    ? [...rows].sort((a, b) => {
        const av = a[sortField] as Date | undefined;
        const bv = b[sortField] as Date | undefined;
        return (bv?.getTime() ?? 0) - (av?.getTime() ?? 0);
      })
    : rows;
  const promise = Promise.resolve(sorted);
  return {
    orderBy: () => Promise.resolve(sorted),
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => promise.then(resolve, reject),
    catch: (reject: (e: unknown) => void) => promise.catch(reject),
  };
}

vi.mock("@bos/db", () => {
  const db = {
    select: (cols?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (condition: { queryChunks: unknown[] }) => {
          if (table === tenantsTable) return thenable([fakeState.tenant]);
          const source = sourceFor(table);
          const values = extractEqValues(condition);
          const filtered = source.filter((row) => matchesCondition(row, values));
          if (!cols) return thenable(filtered, sortFieldFor(table));
          const projected = filtered.map((row) => {
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(cols)) out[key] = row[key];
            return out;
          });
          return thenable(projected);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        returning: async () => {
          const row: Record<string, unknown> = {
            id: `${(table as { __name: string }).__name}-${fakeState.nextQuoteId++}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...vals,
          };
          sourceFor(table).push(row);
          return [row];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: { queryChunks: unknown[] }) => {
          const source = sourceFor(table);
          const conditionValues = extractEqValues(condition);
          const target = source.find((row) => matchesCondition(row, conditionValues));
          if (target) Object.assign(target, values);
          const result = target ? [target] : [];
          const promise = Promise.resolve(result);
          return {
            returning: async () => result,
            then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => promise.then(resolve, reject),
            catch: (reject: (e: unknown) => void) => promise.catch(reject),
          };
        },
      }),
    }),
    execute: async (query: { queryChunks: unknown[] }) => {
      const sqlText = query.queryChunks
        .filter((c): c is StringChunk => c instanceof StringChunk)
        .map((c) => (c as unknown as { value: string[] }).value.join(""))
        .join("");
      const params = query.queryChunks.filter((c) => !(c instanceof StringChunk));

      if (sqlText.includes("insert into deals")) {
        const [tenantId, clientId] = params as [string, string];
        const row: Record<string, unknown> = {
          id: `deal-${fakeState.nextDealId++}`,
          tenantId,
          clientId,
          status: "open",
          lastMessageAt: new Date(),
          customerReportedPaymentNote: null,
          customerReportedPaymentAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        fakeState.deals.push(row);
        return [row];
      }

      if (sqlText.includes("insert into bookings")) {
        const [
          tenantId,
          clientId,
          transferRequestId,
          dealId,
          pickup,
          destination,
          pickupAddress,
          destinationAddress,
          customerTripDurationMinutes,
          scheduledAt,
          finalAmountCents,
          currency,
        ] = params as [
          string,
          string,
          string,
          string | null,
          string,
          string,
          string | null,
          string | null,
          number,
          string,
          number,
          string,
        ];
        const conflict = fakeState.bookings.some((b) => b.transferRequestId === transferRequestId);
        if (conflict) return [];
        const row: Record<string, unknown> = {
          id: `booking-${fakeState.nextBookingId++}`,
          tenantId,
          clientId,
          transferRequestId,
          dealId,
          quoteId: null,
          calendarEventId: null,
          pickup,
          destination,
          pickupAddress,
          destinationAddress,
          customerTripDurationMinutes,
          status: "confirmed",
          currency,
          depositAmountCents: null,
          depositPaidAt: null,
          finalAmountCents,
          scheduledAt: new Date(scheduledAt),
          completedAt: null,
          cancelledAt: null,
          invoicedAt: null,
          invoiceAmountCents: null,
          paidAt: null,
          paidAmountCents: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        fakeState.bookings.push(row);
        return [row];
      }

      if (sqlText.includes("insert into transfer_requests")) {
        const [
          tenantId,
          clientId,
          dealId,
          status,
          intent,
          pickup,
          destination,
          requestedDate,
          requestedTime,
          passengers,
          luggage,
          flightNumber,
          trainNumber,
          hotel,
          language,
        ] = params as [string, string, string, string, ...unknown[]];
        const OPEN_STATUSES = ["collecting_info", "ready_for_pricing"];
        const conflict = fakeState.transferRequests.some(
          (r) => r.tenantId === tenantId && r.clientId === clientId && OPEN_STATUSES.includes(r.status as string),
        );
        if (conflict) return [];
        const row: Record<string, unknown> = {
          id: `request-${fakeState.nextRequestId++}`,
          tenantId,
          clientId,
          dealId,
          status,
          intent,
          pickup,
          destination,
          requestedDate,
          requestedTime,
          passengers,
          luggage,
          flightNumber,
          trainNumber,
          hotel,
          language,
          missingInformation: null,
          pricingStatus: "not_priced",
          calculatedAmountCents: null,
          currency: "EUR",
          pricingBreakdown: null,
          quoteId: null,
          finalAmountCents: null,
          priceOverrideReason: null,
          adminApprovedAt: null,
          adminApprovedBy: null,
          cancelledReason: null,
          pickupAddress: null,
          destinationAddress: null,
          customerTripDurationMinutes: null,
          availabilityBreakdown: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        fakeState.transferRequests.push(row);
        return [row];
      }

      return [];
    },
  };

  return {
    tenants: tenantsTable,
    clients: clientsTable,
    whatsappMessages: whatsappMessagesTable,
    transferRequests: transferRequestsTable,
    deals: dealsTable,
    quotes: quotesTable,
    bookings: bookingsTable,
    businessRules: businessRulesTable,
    businessRuleVersions: businessRuleVersionsTable,
    businessRuleVersionEvidence: businessRuleVersionEvidenceTable,
    evidence: evidenceTable,
    assertOne: (rows: unknown[]) => {
      if (rows.length === 0) throw new Error("Expected exactly one row, got none");
      return rows[0];
    },
    getDb: () => db,
  };
});

const jobsMock = vi.hoisted(() => ({ inngest: {}, emitDomainEvent: vi.fn() }));
vi.mock("@bos/jobs", () => jobsMock);

const defaultMapsError: RouteDistanceResult = {
  status: "error",
  provider: "google_routes_api",
  distanceKm: null,
  durationMinutes: null,
  legs: [],
  error: { code: "api_key_missing", message: "GOOGLE_MAPS_API_KEY is not configured." },
};
// Every route this file's scenarios use is either a fixed fare (Malpensa,
// menaggio_tirano) — which never needs a distance for pricing itself — or
// deliberately irrelevant to pricing (the "two different trips" scenarios
// don't reach pricing assertions on distance). calculateRoute succeeding
// by default only feeds Availability's one-way duration and the Booking
// Snapshot's customerTripDurationMinutes fallback (ensureBookingForApprovedTransferRequestOrThrow),
// neither of which this file asserts a specific value for — it only needs
// ACCEPT to succeed instead of throwing "booking creation failed".
const defaultRouteSuccess: RouteDistanceResult = {
  status: "ok",
  provider: "google_routes_api",
  distanceKm: 40,
  durationMinutes: 45,
  legs: [{ origin: "a", destination: "b", distanceKm: 40, durationMinutes: 45 }],
  error: null,
};
vi.mock("../maps-distance", () => ({
  calculateGenericRouteRoundTrip: vi.fn(async () => defaultMapsError),
  calculateComoTiranoRoundTrip: vi.fn(async () => defaultMapsError),
  calculateRoute: vi.fn(async () => defaultRouteSuccess),
  isComoTiranoRoute: (pickup: string, destination: string) =>
    /como/i.test(pickup + destination) && /tirano/i.test(pickup + destination),
}));

const { processTransferRequestForMessageAndPrice, acceptTransferRequest, getTransferRequest } = await import(
  "./service"
);

const TENANT = fakeState.tenant.id;
// Real, masked-in-diagnosis phone: +91...11 — foreign (does not start with "39").
const CLIENT = "client-real-1";
const FOREIGN_PHONE = "+919000000011";

function seedClient() {
  fakeState.clients.push({ id: CLIENT, tenantId: TENANT, phone: FOREIGN_PHONE, fullName: "G." });
}

let messageCounter = 0;
async function sendMessage(rawText: string, receivedAt: Date, extracted: Record<string, unknown>) {
  const id = `msg-real-${++messageCounter}`;
  fakeState.whatsappMessages.push({
    id,
    tenantId: TENANT,
    clientId: CLIENT,
    transferRequestId: null,
    dealId: null,
    rawText,
    receivedAt,
    parsed: extracted,
  });
  return processTransferRequestForMessageAndPrice({
    tenantId: TENANT,
    clientId: CLIENT,
    whatsappMessageId: id,
    extracted,
  });
}

beforeEach(() => {
  fakeState.clients = [];
  fakeState.whatsappMessages = [];
  fakeState.transferRequests = [];
  fakeState.deals = [];
  fakeState.quotes = [];
  fakeState.bookings = [];
  fakeState.nextRequestId = 1;
  fakeState.nextDealId = 1;
  fakeState.nextQuoteId = 1;
  fakeState.nextBookingId = 1;
  messageCounter = 0;
  jobsMock.emitDomainEvent.mockClear();
  seedClient();
});

describe("the real production incident (2026-09-18) — 4 transfer_requests, 1 negotiation", () => {
  it("resolves all 9 messages to ONE deal, prices the route once, and keeps the card-payment question attached to the priced offer", async () => {
    // 1. "Hi Giovanni, I'd like to check availability..." -> D1 + TR1
    const r1 = await sendMessage(
      "Hi Giovanni, I'd like to check availability for a transfer from Lake Como to Tirano.",
      new Date("2026-09-18T13:56:01Z"),
      { pickup: "Lake Como", destination: "Tirano", intent: "transfer_request", language: "en" },
    );
    expect(r1.status).toBe("collecting_info");
    const dealId = r1.dealId!;
    expect(dealId).toBeTruthy();

    // 2. full route details, a real route conflict against TR1 -> TR1
    // superseded, TR2 created, still under the SAME deal -> priced -> D1 = quoted.
    const r2 = await sendMessage(
      "20/09/2026\n11:00 AM \nGrand Hotel Menaggio to Tirano Station",
      new Date("2026-09-18T13:57:22Z"),
      {
        pickup: "Grand Hotel Menaggio",
        destination: "Tirano Station",
        date: "2026-09-20",
        time: "11:00",
        passengers: 2,
        intent: "transfer_request",
        language: "en",
      },
    );
    expect(r2.dealId).toBe(dealId);
    expect(r2.status).toBe("pending_admin_approval");
    expect(r2.pricingStatus).toBe("fixed");
    expect(r2.calculatedAmountCents).toBe(30000); // menaggio_tirano_fixed_foreign, DEFAULT_PRICING_RATES
    expect((r2.pricingBreakdown as Record<string, unknown>).matchedRule).toBe("menaggio_tirano_fixed_foreign");

    const originalTr1 = await getTransferRequest(TENANT, r1.id);
    expect(originalTr1?.status).toBe("cancelled");
    expect(originalTr1?.dealId).toBe(dealId); // superseded, but never orphaned from the deal

    // 3. deal is now quoted
    let deal = fakeState.deals.find((d) => d.id === dealId)!;
    expect(deal.status).toBe("quoted");

    // 4. "Please allow me a couple of hours..." -> SAME deal, NOT a new empty transfer_request.
    const r4 = await sendMessage(
      "Please allow me a couple of hours.\nI'll get back to you.",
      new Date("2026-09-18T15:42:33Z"),
      { intent: "other", language: "en" },
    );
    expect(r4.dealId).toBe(dealId);
    expect(r4.id).toBe(r2.id); // attached to the already-priced attempt, no new row
    expect(fakeState.transferRequests).toHaveLength(2); // TR1 (cancelled) + TR2 — never 3

    // 5. booking confirmation + card payment question -> SAME deal/TR2, payment_method_inquiry, no new TR.
    const r5 = await sendMessage(
      "Please confirm my booking for 20th September.\nCan we pay by card ?",
      new Date("2026-09-18T18:06:53Z"),
      { intent: "confirmation", language: "en" },
    );
    expect(r5.dealId).toBe(dealId);
    expect(r5.id).toBe(r2.id);
    expect(fakeState.transferRequests).toHaveLength(2);

    // 6. repeating the same route -> SAME deal, price never recalculated
    // (status stays pending_admin_approval, calculatedAmountCents unchanged).
    const r6 = await sendMessage(
      "20/09/2026\n11:00 AM \nGrand Hotel Menaggio to Tirano Station",
      new Date("2026-09-18T18:14:07Z"),
      {
        pickup: "Grand Hotel Menaggio",
        destination: "Tirano Station",
        date: "2026-09-20",
        time: "11:00",
        intent: "transfer_request",
        language: "en",
      },
    );
    expect(r6.dealId).toBe(dealId);
    expect(r6.id).toBe(r2.id);
    expect(r6.status).toBe("pending_admin_approval");
    expect(r6.calculatedAmountCents).toBe(30000); // identical — never recomputed
    expect(fakeState.transferRequests).toHaveLength(2);

    // 7. "You gave an offer to me a few hours back." -> SAME deal (THE FIX —
    // in production this created TR4, a brand new empty transfer_request).
    const r7 = await sendMessage(
      "You gave an offer to me a few hours back.",
      new Date("2026-09-18T18:14:41Z"),
      { intent: "other", language: "en" },
    );
    expect(r7.dealId).toBe(dealId);
    expect(r7.id).toBe(r2.id);
    expect(fakeState.transferRequests).toHaveLength(2);

    // 8. "Paid advance €100" -> SAME deal, recorded as customer-reported
    // payment ONLY — never treated as verified.
    const r8 = await sendMessage("Paid advance €100", new Date("2026-09-18T19:27:20Z"), {
      intent: "payment_confirmation",
      language: "en",
    });
    expect(r8.dealId).toBe(dealId);
    deal = fakeState.deals.find((d) => d.id === dealId)!;
    expect(deal.customerReportedPaymentNote).toBe("Paid advance €100");
    expect(deal.customerReportedPaymentAt).toEqual(new Date("2026-09-18T19:27:20Z"));
    expect(deal.status).toBe("quoted"); // never silently flipped to confirmed by a customer's own claim

    // 9. explicit card payment request -> SAME deal/TR2, same known price context.
    const r9 = await sendMessage(
      "If possible, please arrange to accept payment by card.\nWe are at the end of our Europe tour and don't have much cash left.",
      new Date("2026-09-18T19:33:02Z"),
      { intent: "payment_method_inquiry", language: "en" },
    );
    expect(r9.dealId).toBe(dealId);
    expect(r9.id).toBe(r2.id);

    // FINAL ASSERTIONS — the whole point of Phase 2.5.
    const allDealsForClient = fakeState.deals.filter((d) => d.clientId === CLIENT);
    expect(allDealsForClient).toHaveLength(1); // 1 client -> 1 deal (not 4 transfer_requests worth of confusion)
    expect(fakeState.transferRequests).toHaveLength(2); // TR1 (superseded) + TR2 (priced) — OLD BUG produced 4
    expect(fakeState.transferRequests.filter((r) => r.status === "pending_admin_approval")).toHaveLength(1);
    const pricedRequests = fakeState.transferRequests.filter((r) => r.calculatedAmountCents !== null);
    expect(pricedRequests).toHaveLength(1); // priced exactly ONCE, never twice
    expect(pricedRequests[0]?.calculatedAmountCents).toBe(30000);

    // every message ended up linked to the correct deal
    for (const msg of fakeState.whatsappMessages) {
      expect(msg.dealId).toBe(dealId);
    }
  });
});

describe("two genuinely different trips for the same client", () => {
  it("creates two distinct deals, never merges them", async () => {
    const trip1 = await sendMessage("Transfer to Malpensa please", new Date("2026-09-01T09:00:00Z"), {
      pickup: "Sondrio",
      destination: "Malpensa",
      date: "2026-09-05",
      time: "09:00",
      passengers: 2,
      intent: "transfer_request",
    });

    const trip2 = await sendMessage("Separate trip, different dates", new Date("2026-09-10T09:00:00Z"), {
      pickup: "Milano",
      destination: "Bergamo",
      date: "2026-10-01",
      time: "14:00",
      passengers: 1,
      intent: "transfer_request",
    });

    expect(trip1.dealId).not.toBe(trip2.dealId);
    const clientDeals = fakeState.deals.filter((d) => d.clientId === CLIENT);
    expect(clientDeals).toHaveLength(2);
  });

  it("disambiguates a follow-up message to the correct one of two active deals", async () => {
    const trip1 = await sendMessage("Trip A", new Date("2026-09-01T09:00:00Z"), {
      pickup: "Sondrio",
      destination: "Malpensa",
      date: "2026-09-05",
      time: "09:00",
      passengers: 2,
      intent: "transfer_request",
    });
    const trip2 = await sendMessage("Trip B", new Date("2026-09-10T09:00:00Z"), {
      pickup: "Milano",
      destination: "Bergamo",
      date: "2026-10-01",
      time: "14:00",
      passengers: 1,
      intent: "transfer_request",
    });

    // A follow-up naming trip A's exact route must land on trip A's deal,
    // not trip B's (even though trip B is the most recently touched).
    const followUp = await sendMessage("Confirming Sondrio to Malpensa on 2026-09-05", new Date("2026-09-11T09:00:00Z"), {
      pickup: "Sondrio",
      destination: "Malpensa",
      date: "2026-09-05",
      intent: "confirmation",
    });

    expect(followUp.dealId).toBe(trip1.dealId);
    expect(followUp.dealId).not.toBe(trip2.dealId);
  });
});

describe("quote and booking linking", () => {
  it("creates a quote linked to the deal on ACCEPT, and sets transfer_requests.quote_id", async () => {
    const priced = await sendMessage(
      "Sondrio to Malpensa, 4 pax, 2026-09-20 10:00",
      new Date("2026-09-01T09:00:00Z"),
      { pickup: "Sondrio", destination: "Malpensa", date: "2026-09-20", time: "10:00", passengers: 4, intent: "transfer_request" },
    );
    expect(priced.status).toBe("pending_admin_approval");
    expect(fakeState.quotes).toHaveLength(0); // not yet — only on ACCEPT

    const approved = await acceptTransferRequest(TENANT, priced.id, "admin-1");
    expect(approved.status).toBe("approved");
    expect(approved.quoteId).not.toBeNull();

    expect(fakeState.quotes).toHaveLength(1);
    const quote = fakeState.quotes[0]!;
    expect(quote.dealId).toBe(priced.dealId);
    expect(quote.clientId).toBe(CLIENT);
    expect(quote.amountCents).toBe(approved.finalAmountCents);
    // "sent" carries no meaning beyond "this quote now exists" — see
    // deals/README.md's "Quotes" section. No message is ever sent.
    expect(quote.status).toBe("sent");

    // deal advanced to confirmed, and the booking created is linked too.
    const deal = fakeState.deals.find((d) => d.id === priced.dealId)!;
    expect(deal.status).toBe("confirmed");
    const booking = fakeState.bookings.find((b) => b.transferRequestId === approved.id)!;
    expect(booking.dealId).toBe(priced.dealId);
  });

  it("is idempotent — retrying ACCEPT on an already-approved request never creates a second quote", async () => {
    const priced = await sendMessage(
      "Sondrio to Malpensa, 4 pax, 2026-09-20 10:00",
      new Date("2026-09-01T09:00:00Z"),
      { pickup: "Sondrio", destination: "Malpensa", date: "2026-09-20", time: "10:00", passengers: 4, intent: "transfer_request" },
    );
    await acceptTransferRequest(TENANT, priced.id, "admin-1");
    await acceptTransferRequest(TENANT, priced.id, "admin-1");

    expect(fakeState.quotes).toHaveLength(1);
    expect(fakeState.bookings).toHaveLength(1);
  });
});

describe("regression: transfer_requests state machine is unchanged", () => {
  it("still applies the pricing engine's real menaggio_tirano fixed fare unmodified", async () => {
    const priced = await sendMessage(
      "Grand Hotel Menaggio to Tirano Station, 2 pax, 2026-09-20 11:00",
      new Date("2026-09-18T13:57:22Z"),
      {
        pickup: "Grand Hotel Menaggio",
        destination: "Tirano Station",
        date: "2026-09-20",
        time: "11:00",
        passengers: 2,
        intent: "transfer_request",
      },
    );
    expect(priced.pricingStatus).toBe("fixed");
    expect(priced.calculatedAmountCents).toBe(30000);
    expect(priced.currency).toBe("EUR");
  });
});
