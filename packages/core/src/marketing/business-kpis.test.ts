import { describe, expect, it, vi } from "vitest";

// @bos/db is fully mocked, keyed by table identity — same strategy as
// run-check.test.ts/service.test.ts. `insert` deliberately throws: it
// proves getTransferRequestFunnel is structurally read-only, not just
// read-only by convention — a request is never promoted to quote/booking,
// and no revenue field is ever written, by this function.
const { fakeState, transferRequestsTable } = vi.hoisted(() => {
  return {
    fakeState: { rows: [] as Array<{ status: string }> },
    transferRequestsTable: { __name: "transferRequests" },
  };
});

vi.mock("@bos/db", () => ({
  transferRequests: transferRequestsTable,
  clients: { __name: "clients" },
  quotes: { __name: "quotes" },
  bookings: { __name: "bookings" },
  getDb: () => ({
    select: () => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => Promise.resolve(table === transferRequestsTable ? fakeState.rows : []),
      }),
    }),
    insert: () => {
      throw new Error("getTransferRequestFunnel must never write — insert() should not be called");
    },
  }),
}));

const { getTransferRequestFunnel } = await import("./business-kpis");

function request(status: string) {
  return { status };
}

describe("getTransferRequestFunnel", () => {
  it("returns all zeros (and total 0) when there are no transfer requests", async () => {
    fakeState.rows = [];

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
    fakeState.rows = [
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
    fakeState.rows = [
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
    fakeState.rows = [request("approved"), request("converted_to_quote")];

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
