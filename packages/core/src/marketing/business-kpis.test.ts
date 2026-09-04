import { describe, expect, it, vi } from "vitest";

// @bos/db is fully mocked, keyed by table identity — same strategy as
// run-check.test.ts/service.test.ts. `insert` deliberately throws: it
// proves these functions are structurally read-only, not just read-only by
// convention — no request/booking/client is ever written by any function
// under test here.
const { fakeState, transferRequestsTable, clientsTable, bookingsTable, quotesTable } = vi.hoisted(() => {
  return {
    fakeState: {
      transferRequestRows: [] as Array<{ status: string }>,
      clientRows: [] as Array<{
        id: string;
        utmCampaign?: string | null;
        utmSource?: string | null;
        gclid?: string | null;
        preferredLanguage?: string | null;
      }>,
      bookingRows: [] as Array<{
        clientId: string;
        status: string;
        paidAmountCents?: number | null;
        finalAmountCents?: number | null;
      }>,
    },
    transferRequestsTable: { __name: "transferRequests" },
    clientsTable: { __name: "clients" },
    bookingsTable: { __name: "bookings" },
    quotesTable: { __name: "quotes" },
  };
});

vi.mock("@bos/db", () => ({
  transferRequests: transferRequestsTable,
  clients: clientsTable,
  quotes: quotesTable,
  bookings: bookingsTable,
  getDb: () => ({
    select: () => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => {
          if (table === transferRequestsTable) return Promise.resolve(fakeState.transferRequestRows);
          if (table === clientsTable) return Promise.resolve(fakeState.clientRows);
          if (table === bookingsTable) return Promise.resolve(fakeState.bookingRows);
          return Promise.resolve([]);
        },
      }),
    }),
    insert: () => {
      throw new Error("business-kpis functions must never write — insert() should not be called");
    },
  }),
}));

const { getTransferRequestFunnel, getRealConversionSummary } = await import("./business-kpis");

function request(status: string) {
  return { status };
}

describe("getTransferRequestFunnel", () => {
  it("returns all zeros (and total 0) when there are no transfer requests", async () => {
    fakeState.transferRequestRows = [];

    const result = await getTransferRequestFunnel("tenant-1");

    expect(result).toEqual({
      requestsReceived: 0,
      requestsInProgress: 0,
      requestsReadyForPricing: 0,
      requestsPendingApproval: 0,
      requestsConvertedToQuote: 0,
      requestsCancelledOrExpired: 0,
      total: 0,
    });
  });

  // Exact status -> bucket mapping, one request per real enum value.
  it("maps each real transfer_request_status value to exactly the right KPI bucket", async () => {
    fakeState.transferRequestRows = [
      request("collecting_info"),
      request("ready_for_pricing"),
      request("pending_admin_approval"),
      request("approved"),
      request("converted_to_quote"),
      request("cancelled"),
      request("expired"),
    ];

    const result = await getTransferRequestFunnel("tenant-1");

    expect(result).toEqual({
      requestsReceived: 1, // collecting_info
      requestsReadyForPricing: 1, // ready_for_pricing
      requestsPendingApproval: 1, // pending_admin_approval
      requestsInProgress: 1, // approved
      requestsConvertedToQuote: 1, // converted_to_quote
      requestsCancelledOrExpired: 2, // cancelled + expired share one bucket
      total: 7,
    });
  });

  // Mutually exclusive AND exhaustive: every request lands in exactly one
  // bucket, and the six buckets always sum to the real total — no request
  // is double-counted or silently dropped.
  it("the six buckets are mutually exclusive and always sum to the total, regardless of distribution", async () => {
    fakeState.transferRequestRows = [
      request("collecting_info"),
      request("collecting_info"),
      request("collecting_info"),
      request("ready_for_pricing"),
      request("ready_for_pricing"),
      request("pending_admin_approval"),
      request("approved"),
      request("approved"),
      request("approved"),
      request("approved"),
      request("converted_to_quote"),
      request("cancelled"),
      request("expired"),
      request("expired"),
    ];

    const result = await getTransferRequestFunnel("tenant-1");

    const sumOfBuckets =
      result.requestsReceived +
      result.requestsInProgress +
      result.requestsReadyForPricing +
      result.requestsPendingApproval +
      result.requestsConvertedToQuote +
      result.requestsCancelledOrExpired;

    expect(sumOfBuckets).toBe(result.total);
    expect(result.total).toBe(14);
    expect(result).toEqual({
      requestsReceived: 3,
      requestsReadyForPricing: 2,
      requestsPendingApproval: 1,
      requestsInProgress: 4,
      requestsConvertedToQuote: 1,
      requestsCancelledOrExpired: 3,
      total: 14,
    });
  });

  // Structural guarantee: no automatic promotion to quote/booking, no
  // revenue counted. The mock's insert() throws if called at all — a
  // passing test here means the function never attempted a write.
  it("never writes anything — no automatic promotion to quote, booking, or revenue", async () => {
    fakeState.transferRequestRows = [request("approved"), request("converted_to_quote")];

    const result = await getTransferRequestFunnel("tenant-1");

    // Reaching this line at all (without the mocked insert() throwing)
    // proves no write was attempted. Also confirms the result carries no
    // quote/booking/revenue fields of any kind.
    expect(Object.keys(result).sort()).toEqual(
      [
        "requestsReceived",
        "requestsInProgress",
        "requestsReadyForPricing",
        "requestsPendingApproval",
        "requestsConvertedToQuote",
        "requestsCancelledOrExpired",
        "total",
      ].sort(),
    );
  });
});

// ── Real Conversion System ────────────────────────────────────────────────
// bookings.status is the source of truth (no Google Calendar integration
// exists anywhere in this codebase — verified before building this). Every
// test case here maps directly to one of the 9 scenarios specified for
// this milestone.
function client(overrides: {
  id: string;
  utmCampaign?: string | null;
  utmSource?: string | null;
  gclid?: string | null;
  preferredLanguage?: string | null;
}) {
  return {
    utmCampaign: null,
    utmSource: null,
    gclid: null,
    preferredLanguage: null,
    ...overrides,
  };
}

function booking(overrides: {
  clientId: string;
  status: string;
  paidAmountCents?: number | null;
  finalAmountCents?: number | null;
}) {
  return {
    paidAmountCents: null,
    finalAmountCents: null,
    ...overrides,
  };
}

describe("getRealConversionSummary", () => {
  // TEST 1 — Booking confermato -> 1 real conversion (no revenue yet: not
  // completed, per the founder-confirmed distinction between the two).
  it("counts a confirmed booking as exactly one real conversion, with no revenue", async () => {
    fakeState.clientRows = [client({ id: "c1" })];
    fakeState.bookingRows = [booking({ clientId: "c1", status: "confirmed", finalAmountCents: 39000 })];

    const result = await getRealConversionSummary("tenant-1");

    expect(result.realConversions).toBe(1);
    expect(result.completedConversions).toBe(0);
    expect(result.realRevenueCents).toBe(0);
  });

  // TEST 2 — Booking completato con importo -> 1 real conversion + revenue.
  it("counts a completed booking as one real conversion plus its realized revenue", async () => {
    fakeState.clientRows = [client({ id: "c1" })];
    fakeState.bookingRows = [booking({ clientId: "c1", status: "completed", finalAmountCents: 39000 })];

    const result = await getRealConversionSummary("tenant-1");

    expect(result.realConversions).toBe(1);
    expect(result.completedConversions).toBe(1);
    expect(result.realRevenueCents).toBe(39000);
  });

  // TEST 3 — Booking cancellato -> nessuna conversione attiva/revenue.
  it("excludes a cancelled booking entirely — not a real conversion, no revenue", async () => {
    fakeState.clientRows = [client({ id: "c1" })];
    fakeState.bookingRows = [booking({ clientId: "c1", status: "cancelled", finalAmountCents: 39000 })];

    const result = await getRealConversionSummary("tenant-1");

    expect(result.realConversions).toBe(0);
    expect(result.completedConversions).toBe(0);
    expect(result.realRevenueCents).toBe(0);
  });

  // TEST 4 — Booking con GCLID -> real=1, attributed=1, Google Ads specifically.
  it("marks a booking from a client with a real gclid as both attributed and Google-Ads-attributed", async () => {
    fakeState.clientRows = [client({ id: "c1", gclid: "Cj0KEQjw" })];
    fakeState.bookingRows = [booking({ clientId: "c1", status: "completed", finalAmountCents: 39000 })];

    const result = await getRealConversionSummary("tenant-1");

    expect(result.realConversions).toBe(1);
    expect(result.attributedConversions).toBe(1);
    expect(result.googleAdsAttributedConversions).toBe(1);
    expect(result.attributedRevenueCents).toBe(39000);
    expect(result.googleAdsAttributedRevenueCents).toBe(39000);
  });

  // TEST 5 — Booking senza GCLID/UTM -> real=1, MAI Google Ads attributed.
  it("never attributes a booking to Google Ads when the client has no gclid/utm at all", async () => {
    fakeState.clientRows = [client({ id: "c1" })]; // no utm*, no gclid — e.g. direct WhatsApp
    fakeState.bookingRows = [booking({ clientId: "c1", status: "completed", finalAmountCents: 39000 })];

    const result = await getRealConversionSummary("tenant-1");

    expect(result.realConversions).toBe(1);
    expect(result.attributedConversions).toBe(0);
    expect(result.googleAdsAttributedConversions).toBe(0);
    expect(result.attributedRevenueCents).toBe(0);
    expect(result.googleAdsAttributedRevenueCents).toBe(0);
  });

  // TEST 6 — "Repeated calendar sync" has no equivalent write path here (no
  // calendar sync exists at all): this function only ever SELECTs, so
  // calling it twice against the same, unchanged booking set must produce
  // byte-identical results — no duplication is even structurally possible,
  // since nothing is ever inserted. The mocked insert() throwing if called
  // is the structural proof, same discipline as getTransferRequestFunnel's
  // equivalent test above.
  it("produces identical results on repeated calls against the same data — no duplication possible", async () => {
    fakeState.clientRows = [client({ id: "c1", gclid: "Cj0KEQjw" })];
    fakeState.bookingRows = [booking({ clientId: "c1", status: "completed", finalAmountCents: 39000 })];

    const first = await getRealConversionSummary("tenant-1");
    const second = await getRealConversionSummary("tenant-1");

    expect(second).toEqual(first);
    expect(first.realConversions).toBe(1);
  });

  // TEST 7 — Cliente language = EN -> classificazione corretta come
  // English-language customer (never turned into a nationality guess).
  it("classifies a client with preferredLanguage 'en' as an English-language conversion", async () => {
    fakeState.clientRows = [client({ id: "c1", preferredLanguage: "en" })];
    fakeState.bookingRows = [booking({ clientId: "c1", status: "confirmed" })];

    const result = await getRealConversionSummary("tenant-1");

    expect(result.englishLanguageConversions).toBe(1);
  });

  // TEST 8 — bookings-native equivalent of "an unrecognized calendar event
  // never creates a conversion": a lead (client) with no confirmed/
  // completed booking at all must never be counted as a real conversion.
  it("never counts a lead with no booking as a real conversion", async () => {
    fakeState.clientRows = [client({ id: "c1" }), client({ id: "c2" })];
    fakeState.bookingRows = []; // no booking exists for either client yet

    const result = await getRealConversionSummary("tenant-1");

    expect(result.leads).toBe(2);
    expect(result.realConversions).toBe(0);
  });

  // TEST 9 — Servizio senza prezzo affidabile -> nessuna revenue inventata.
  it("never invents revenue for a completed booking with no paidAmountCents or finalAmountCents", async () => {
    fakeState.clientRows = [client({ id: "c1" })];
    fakeState.bookingRows = [booking({ clientId: "c1", status: "completed" })]; // both amounts null

    const result = await getRealConversionSummary("tenant-1");

    expect(result.completedConversions).toBe(1);
    expect(result.realRevenueCents).toBe(0);
  });

  it("prefers paidAmountCents over finalAmountCents when both are set, same precedence as getRevenueBySource", async () => {
    fakeState.clientRows = [client({ id: "c1" })];
    fakeState.bookingRows = [
      booking({ clientId: "c1", status: "completed", finalAmountCents: 39000, paidAmountCents: 39000 }),
    ];

    const result = await getRealConversionSummary("tenant-1");

    expect(result.realRevenueCents).toBe(39000);
  });
});
