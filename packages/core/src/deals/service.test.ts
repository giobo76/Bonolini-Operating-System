import { Param, StringChunk } from "drizzle-orm";
import { describe, expect, it, vi, beforeEach } from "vitest";

// @bos/db fully mocked — same convention as transfer-requests/service.test.ts
// and whatsapp/service.test.ts (no test-database strategy exists yet). This
// module's own mock is intentionally smaller: only deals/transferRequests/
// bookings, the three tables service.ts actually touches.

const { fakeState, dealsTable, transferRequestsTable, bookingsTable } = vi.hoisted(() => {
  return {
    fakeState: {
      deals: [] as Array<Record<string, unknown>>,
      transferRequests: [] as Array<Record<string, unknown>>,
      bookings: [] as Array<Record<string, unknown>>,
      nextDealId: 1,
    },
    dealsTable: { __name: "deals" },
    transferRequestsTable: { __name: "transferRequests" },
    bookingsTable: { __name: "bookings" },
  };
});

// Unlike the sibling mocks (transfer-requests/service.test.ts,
// whatsapp-pricing-simulation.integration.test.ts), orderBy() here actually
// sorts — this module's own matching/disambiguation logic depends on real
// "most recently touched first" ordering (getActiveDealsForClient,
// getMostRecentTransferRequestForDeal), unlike those files' equivalent
// calls, which only ever operate on a single relevant seeded row.
function thenable(rows: Array<Record<string, unknown>>, sortField?: string) {
  const sorted = sortField
    ? [...rows].sort((a, b) => {
        const av = a[sortField] as Date | undefined;
        const bv = b[sortField] as Date | undefined;
        return (bv?.getTime() ?? 0) - (av?.getTime() ?? 0); // desc
      })
    : rows;
  const promise = Promise.resolve(sorted);
  return {
    orderBy: () => promise,
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => promise.then(resolve, reject),
    catch: (reject: (e: unknown) => void) => promise.catch(reject),
  };
}

function sortFieldFor(table: unknown): string | undefined {
  if (table === dealsTable) return "lastMessageAt";
  if (table === transferRequestsTable) return "createdAt";
  return undefined;
}

function sourceFor(table: unknown): Array<Record<string, unknown>> {
  if (table === dealsTable) return fakeState.deals;
  if (table === transferRequestsTable) return fakeState.transferRequests;
  return fakeState.bookings;
}

// Generalized eq()-value extraction: recursively walks a condition's
// queryChunks, pulling out every bound scalar — needed because and(eq(...),
// eq(...)) nests each eq()'s own SQL object one level inside the outer
// and()'s queryChunks rather than flattening them (transfer-requests/service.test.ts's
// own equivalent helper works only for a single, non-nested eq() for
// exactly this reason — its own comment says so explicitly). Handles both
// the Param-wrapped and raw-chunk shapes the mocked placeholder tables
// produce, at any nesting depth.
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

// A row matches a condition when every bound value the condition carries
// appears somewhere among that row's own field values — robust to exact
// field order without needing to hand-decode drizzle's and()/eq() chunk
// layout, and correct for this file's fixtures (UUID-like ids/tenant/client
// strings never collide by accident).
function matchesCondition(row: Record<string, unknown>, values: string[]): boolean {
  return values.every((value) => Object.values(row).includes(value));
}

vi.mock("@bos/db", () => {
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: { queryChunks: unknown[] }) => {
          const source = sourceFor(table);
          const values = extractEqValues(condition);
          return thenable(source.filter((row) => matchesCondition(row, values)), sortFieldFor(table));
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
      return [];
    },
  };

  return {
    deals: dealsTable,
    transferRequests: transferRequestsTable,
    bookings: bookingsTable,
    assertOne: (rows: unknown[]) => {
      if (rows.length === 0) throw new Error("Expected exactly one row, got none");
      return rows[0];
    },
    getDb: () => db,
  };
});

const {
  createDeal,
  getDeal,
  getActiveDealsForClient,
  findMatchingDealForMessage,
  reopenRecentClosedDealIfMatching,
  closeDeal,
  advanceDealStatus,
  touchDealLastMessageAt,
  looksLikeCustomerReportedPayment,
  recordCustomerReportedPayment,
} = await import("./service");

const TENANT = "tenant-1";
const CLIENT = "client-1";

function seedDeal(overrides: Partial<Record<string, unknown>> = {}) {
  const row = {
    id: `deal-seed-${fakeState.deals.length + 1}`,
    tenantId: TENANT,
    clientId: CLIENT,
    status: "open",
    lastMessageAt: new Date("2026-09-18T10:00:00Z"),
    customerReportedPaymentNote: null,
    customerReportedPaymentAt: null,
    createdAt: new Date("2026-09-18T10:00:00Z"),
    updatedAt: new Date("2026-09-18T10:00:00Z"),
    ...overrides,
  };
  fakeState.deals.push(row);
  return row;
}

function seedTransferRequest(dealId: string, overrides: Partial<Record<string, unknown>> = {}) {
  const row = {
    id: `tr-seed-${fakeState.transferRequests.length + 1}`,
    tenantId: TENANT,
    clientId: CLIENT,
    dealId,
    pickup: null,
    destination: null,
    requestedDate: null,
    createdAt: new Date("2026-09-18T10:00:01Z"),
    ...overrides,
  };
  fakeState.transferRequests.push(row);
  return row;
}

beforeEach(() => {
  fakeState.deals = [];
  fakeState.transferRequests = [];
  fakeState.bookings = [];
  fakeState.nextDealId = 1;
});

// 1. create deal
describe("createDeal", () => {
  it("creates a new deal at status 'open' for the given tenant/client", async () => {
    const deal = await createDeal(TENANT, CLIENT);
    expect(deal.status).toBe("open");
    expect(deal.tenantId).toBe(TENANT);
    expect(deal.clientId).toBe(CLIENT);
    expect(fakeState.deals).toHaveLength(1);
  });
});

// 2. tenant isolation
describe("tenant isolation", () => {
  it("getDeal never returns a deal belonging to a different tenant", async () => {
    const deal = seedDeal({ tenantId: "tenant-other" });
    const result = await getDeal(TENANT, deal.id as string);
    expect(result).toBeNull();
  });

  it("getActiveDealsForClient never returns another tenant's deals", async () => {
    seedDeal({ tenantId: "tenant-other", status: "open" });
    const result = await getActiveDealsForClient(TENANT, CLIENT);
    expect(result).toHaveLength(0);
  });
});

// 3/4/5. active deal matching — open/quoted/confirmed all count
describe("getActiveDealsForClient", () => {
  it.each(["open", "quoted", "confirmed"] as const)("treats a '%s' deal as active", async (status) => {
    seedDeal({ status });
    const result = await getActiveDealsForClient(TENANT, CLIENT);
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe(status);
  });

  it.each(["completed", "cancelled"] as const)("does not treat a '%s' deal as active", async (status) => {
    seedDeal({ status });
    const result = await getActiveDealsForClient(TENANT, CLIENT);
    expect(result).toHaveLength(0);
  });
});

describe("findMatchingDealForMessage", () => {
  it("returns the client's single active deal without disambiguation", async () => {
    const deal = seedDeal({ status: "quoted" });
    const result = await findMatchingDealForMessage(TENANT, CLIENT, { pickup: "Sondrio" });
    expect(result.deal.id).toBe(deal.id);
    expect(result.isNew).toBe(false);
    expect(result.reopened).toBe(false);
  });

  it("creates a brand new deal when none exists", async () => {
    const result = await findMatchingDealForMessage(TENANT, CLIENT, {});
    expect(result.isNew).toBe(true);
    expect(result.deal.status).toBe("open");
    expect(fakeState.deals).toHaveLength(1);
  });

  // 6/7. multiple active deals -> route/date disambiguation
  it("disambiguates between two active deals by the strongest pickup+destination+date match", async () => {
    const dealA = seedDeal({ id: "deal-A", status: "quoted", lastMessageAt: new Date("2026-09-01T00:00:00Z") });
    const dealB = seedDeal({ id: "deal-B", status: "quoted", lastMessageAt: new Date("2026-09-10T00:00:00Z") });
    seedTransferRequest(dealA.id as string, { pickup: "Milano", destination: "Malpensa", requestedDate: "2026-09-05" });
    seedTransferRequest(dealB.id as string, {
      pickup: "Grand Hotel Menaggio",
      destination: "Tirano Station",
      requestedDate: "2026-09-20",
    });

    const result = await findMatchingDealForMessage(TENANT, CLIENT, {
      pickup: "Grand Hotel Menaggio",
      destination: "Tirano Station",
      date: "2026-09-20",
    });

    expect(result.deal.id).toBe("deal-B");
  });

  it("falls back to the most-recently-touched deal on a genuine scoring tie", async () => {
    const dealA = seedDeal({ id: "deal-A", status: "open", lastMessageAt: new Date("2026-09-01T00:00:00Z") });
    const dealB = seedDeal({ id: "deal-B", status: "open", lastMessageAt: new Date("2026-09-10T00:00:00Z") });
    seedTransferRequest(dealA.id as string, { pickup: null, destination: null, requestedDate: null });
    seedTransferRequest(dealB.id as string, { pickup: null, destination: null, requestedDate: null });

    // No route info at all -> both score 0 -> tie -> most recently touched wins.
    const result = await findMatchingDealForMessage(TENANT, CLIENT, {});
    expect(result.deal.id).toBe("deal-B");
  });
});

// 8. recent closed deal reopening
describe("reopenRecentClosedDealIfMatching", () => {
  it("reopens a recently cancelled deal with a strong route match and no booking", async () => {
    const deal = seedDeal({
      status: "cancelled",
      updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago
    });
    seedTransferRequest(deal.id as string, { pickup: "Milano", destination: "Tirano", requestedDate: "2026-09-20" });

    const result = await reopenRecentClosedDealIfMatching(TENANT, CLIENT, {
      pickup: "Milano",
      destination: "Tirano",
      date: "2026-09-20",
    });

    expect(result).not.toBeNull();
    expect(result?.status).toBe("open");
  });

  it("does not reopen a cancelled deal outside the reopen window", async () => {
    const deal = seedDeal({
      status: "cancelled",
      updatedAt: new Date(Date.now() - 200 * 60 * 60 * 1000), // ~8 days ago
    });
    seedTransferRequest(deal.id as string, { pickup: "Milano", destination: "Tirano", requestedDate: "2026-09-20" });

    const result = await reopenRecentClosedDealIfMatching(TENANT, CLIENT, {
      pickup: "Milano",
      destination: "Tirano",
    });
    expect(result).toBeNull();
  });

  // 9. old completed deal never reopens
  it("never reopens a 'completed' deal, regardless of how recent", async () => {
    const deal = seedDeal({ status: "completed", updatedAt: new Date(Date.now() - 60 * 1000) });
    seedTransferRequest(deal.id as string, { pickup: "Milano", destination: "Tirano", requestedDate: "2026-09-20" });

    const result = await reopenRecentClosedDealIfMatching(TENANT, CLIENT, {
      pickup: "Milano",
      destination: "Tirano",
    });
    expect(result).toBeNull();
  });

  it("never reopens a cancelled deal that already has a booking recorded against it", async () => {
    const deal = seedDeal({ status: "cancelled", updatedAt: new Date(Date.now() - 60 * 1000) });
    seedTransferRequest(deal.id as string, { pickup: "Milano", destination: "Tirano", requestedDate: "2026-09-20" });
    fakeState.bookings.push({ id: "booking-1", dealId: deal.id, tenantId: TENANT });

    const result = await reopenRecentClosedDealIfMatching(TENANT, CLIENT, {
      pickup: "Milano",
      destination: "Tirano",
    });
    expect(result).toBeNull();
  });

  it("never reopens without a strong pickup+destination match", async () => {
    const deal = seedDeal({ status: "cancelled", updatedAt: new Date(Date.now() - 60 * 1000) });
    seedTransferRequest(deal.id as string, { pickup: "Milano", destination: "Tirano", requestedDate: "2026-09-20" });

    const result = await reopenRecentClosedDealIfMatching(TENANT, CLIENT, {
      pickup: "Roma",
      destination: "Napoli",
    });
    expect(result).toBeNull();
  });
});

describe("advanceDealStatus", () => {
  it("moves a deal forward (open -> quoted)", async () => {
    const deal = seedDeal({ status: "open" });
    const result = await advanceDealStatus(TENANT, deal.id as string, "quoted");
    expect(result?.status).toBe("quoted");
  });

  it("never regresses an already-confirmed deal back to quoted", async () => {
    const deal = seedDeal({ status: "confirmed" });
    const result = await advanceDealStatus(TENANT, deal.id as string, "quoted");
    expect(result?.status).toBe("confirmed");
  });

  it("returns null for a deal that does not exist", async () => {
    const result = await advanceDealStatus(TENANT, "missing-deal", "quoted");
    expect(result).toBeNull();
  });
});

describe("closeDeal", () => {
  it("sets status to 'cancelled' explicitly", async () => {
    const deal = seedDeal({ status: "open" });
    const result = await closeDeal(TENANT, deal.id as string, "cancelled");
    expect(result.status).toBe("cancelled");
  });
});

describe("touchDealLastMessageAt", () => {
  it("updates last_message_at", async () => {
    const deal = seedDeal({ lastMessageAt: new Date("2026-01-01T00:00:00Z") });
    const now = new Date("2026-09-18T19:33:02Z");
    await touchDealLastMessageAt(TENANT, deal.id as string, now);
    expect((fakeState.deals[0] as { lastMessageAt: Date }).lastMessageAt).toEqual(now);
  });
});

// 14/15. customer-reported payment — recorded, never treated as verified
describe("customer-reported payment", () => {
  it("looksLikeCustomerReportedPayment matches a payment-labeled intent", () => {
    expect(looksLikeCustomerReportedPayment("payment_method_inquiry")).toBe(true);
    expect(looksLikeCustomerReportedPayment("payment_confirmation")).toBe(true);
  });

  it("looksLikeCustomerReportedPayment does not match an unrelated intent", () => {
    expect(looksLikeCustomerReportedPayment("confirmation")).toBe(false);
    expect(looksLikeCustomerReportedPayment("other")).toBe(false);
    expect(looksLikeCustomerReportedPayment(undefined)).toBe(false);
    expect(looksLikeCustomerReportedPayment(null)).toBe(false);
  });

  it("recordCustomerReportedPayment sets only the note/timestamp fields, never a 'paid' status", async () => {
    const deal = seedDeal({ status: "quoted" });
    const at = new Date("2026-09-18T19:27:20Z");

    await recordCustomerReportedPayment(TENANT, deal.id as string, "Paid advance €100", at);

    const row = fakeState.deals[0] as Record<string, unknown>;
    expect(row.customerReportedPaymentNote).toBe("Paid advance €100");
    expect(row.customerReportedPaymentAt).toEqual(at);
    // Never touched by this call — this is explicitly not a payment system.
    expect(row.status).toBe("quoted");
  });
});
