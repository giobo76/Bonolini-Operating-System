import { describe, expect, it, vi, beforeEach } from "vitest";

const runReport = vi.fn();

vi.mock("../google-clients", () => ({
  getAnalyticsDataClient: async () => ({ properties: { runReport } }),
}));

// Same strategy as service.test.ts/attribution-checks.test.ts: @bos/db is
// fully mocked, keyed by table identity. clientsRows defaults to [] so
// every pre-existing test (none of which cares about the DB) is unaffected.
const { fakeDb, clientsTable } = vi.hoisted(() => {
  return {
    fakeDb: { clientsRows: [] as Array<{ id: string }> },
    clientsTable: { __name: "clients" },
  };
});

vi.mock("@bos/db", () => ({
  clients: clientsTable,
  getDb: () => ({
    select: () => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => Promise.resolve(table === clientsTable ? fakeDb.clientsRows : []),
      }),
    }),
  }),
}));

const { runChecks, severityForBaseline, confidenceForBaseline } = await import("./ga4-checks");

// WINDOW_DAYS is a private constant of ga4-checks.ts (7 in production code).
// These literals mirror it rather than importing it, so a test failure here
// is a direct, readable signal that the module's window construction
// changed — see the "regression" tests below for the same reasoning applied
// to the exact date-range strings.
const RECENT_START = "6daysAgo";
const PREVIOUS_START = "13daysAgo";
const PREVIOUS_END = "7daysAgo";

function eventRow(eventName: string, count: number) {
  return { dimensionValues: [{ value: eventName }], metricValues: [{ value: String(count) }] };
}

function isEventRequest(requestBody: { dimensions?: unknown[] }): boolean {
  return Array.isArray(requestBody.dimensions) && requestBody.dimensions.length > 0;
}

function isRecentRequest(requestBody: { dateRanges: [{ startDate: string }] }): boolean {
  return requestBody.dateRanges[0].startDate === RECENT_START;
}

function mockGa4({
  recentEventRows = [] as ReturnType<typeof eventRow>[],
  previousEventRows = [] as ReturnType<typeof eventRow>[],
  recentSessionCount = 0,
  previousSessionCount = 0,
} = {}) {
  runReport.mockImplementation(async ({ requestBody }: { requestBody: { dimensions?: unknown[]; dateRanges: [{ startDate: string }] } }) => {
    const recent = isRecentRequest(requestBody);
    if (isEventRequest(requestBody)) {
      return { data: { rows: recent ? recentEventRows : previousEventRows } };
    }
    return { data: { rows: [{ metricValues: [{ value: String(recent ? recentSessionCount : previousSessionCount) }] }] } };
  });
}

describe("ga4-checks — severityForBaseline / confidenceForBaseline (pure functions)", () => {
  it("classifies severity as medium below the high-severity sample-size threshold", () => {
    expect(severityForBaseline(20)).toBe("medium");
    expect(severityForBaseline(99)).toBe("medium");
  });

  it("classifies severity as high at/above the high-severity sample-size threshold", () => {
    expect(severityForBaseline(100)).toBe("high");
    expect(severityForBaseline(500)).toBe("high");
  });

  it("tiers confidence by baseline sample size: 20-49 -> 55, 50-99 -> 70, >=100 -> 80", () => {
    expect(confidenceForBaseline(20)).toBe(55);
    expect(confidenceForBaseline(49)).toBe(55);
    expect(confidenceForBaseline(50)).toBe(70);
    expect(confidenceForBaseline(99)).toBe(70);
    expect(confidenceForBaseline(100)).toBe(80);
    expect(confidenceForBaseline(1000)).toBe(80);
  });
});

describe("ga4-checks — runChecks traffic-drop", () => {
  beforeEach(() => {
    runReport.mockReset();
    fakeDb.clientsRows = [];
  });

  it("A: produces no finding when the baseline is below MIN_BASELINE_SESSIONS, however large the drop", async () => {
    mockGa4({ previousSessionCount: 15, recentSessionCount: 1 });

    const drafts = await runChecks("tenant-1", "524948086");

    expect(drafts).toHaveLength(0);
  });

  it("B: a >=50% drop with baseline 20-99 produces a medium-severity finding (real production case: 44 -> 16)", async () => {
    mockGa4({ previousSessionCount: 44, recentSessionCount: 16 });

    const drafts = await runChecks("tenant-1", "524948086");

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      dedupeKey: "ga4_traffic_drop:524948086",
      category: "organic_traffic",
      severity: "medium",
      confidenceScore: 55,
    });
  });

  it("C: a >=50% drop with baseline >=100 produces a high-severity finding", async () => {
    mockGa4({ previousSessionCount: 150, recentSessionCount: 50 });

    const drafts = await runChecks("tenant-1", "524948086");

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      severity: "high",
      confidenceScore: 80,
    });
  });

  it("does not fire when the drop is below the -50% threshold, regardless of baseline size", async () => {
    mockGa4({ previousSessionCount: 200, recentSessionCount: 150 }); // -25%

    const drafts = await runChecks("tenant-1", "524948086");

    expect(drafts).toHaveLength(0);
  });

  it("F: computes recentDailyAvg/previousDailyAvg/changePct from the two 7-day windows and includes them in evidence", async () => {
    mockGa4({ previousSessionCount: 140, recentSessionCount: 70 }); // exactly -50% at the threshold boundary

    const drafts = await runChecks("tenant-1", "524948086");

    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.evidence).toMatchObject({
      propertyId: "524948086",
      recentSessionCount: 70,
      previousSessionCount: 140,
      recentWindowDays: 7,
      previousWindowDays: 7,
      recentDailyAvg: 10,
      previousDailyAvg: 20,
      changePct: -0.5,
    });
  });

  it("E: requests recent and previous windows of equal duration", async () => {
    mockGa4({ previousSessionCount: 44, recentSessionCount: 16 });

    await runChecks("tenant-1", "524948086");

    const sessionCalls = runReport.mock.calls.filter(([{ requestBody }]) => !isEventRequest(requestBody));
    expect(sessionCalls).toHaveLength(2);

    function windowLengthDays(startDate: string, endDate: string): number {
      const parse = (label: string) => (label === "today" ? 0 : Number(label.replace("daysAgo", "")));
      return parse(startDate) - parse(endDate) + 1;
    }

    const [recentCall, previousCall] = sessionCalls.map(([{ requestBody }]) => requestBody.dateRanges[0]);
    expect(windowLengthDays(recentCall.startDate, recentCall.endDate)).toBe(
      windowLengthDays(previousCall.startDate, previousCall.endDate),
    );
  });

  it("H: regression — recent/previous windows are contiguous 7-day ranges, not the old 4-day/7-day split", async () => {
    mockGa4({ previousSessionCount: 44, recentSessionCount: 16 });

    await runChecks("tenant-1", "524948086");

    const sessionCalls = runReport.mock.calls.filter(([{ requestBody }]) => !isEventRequest(requestBody));
    const ranges = sessionCalls.map(([{ requestBody }]) => requestBody.dateRanges[0]);

    expect(ranges).toContainEqual({ startDate: RECENT_START, endDate: "today" });
    expect(ranges).toContainEqual({ startDate: PREVIOUS_START, endDate: PREVIOUS_END });
  });

  it("G: event-stopped-firing still fires on recentCount === 0 && previousCount > 0, using the same-length windows", async () => {
    mockGa4({
      previousEventRows: [eventRow("generate_lead", 12)],
      recentEventRows: [],
      previousSessionCount: 0,
      recentSessionCount: 0,
    });

    const drafts = await runChecks("tenant-1", "524948086");

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      dedupeKey: "ga4_event_stopped:524948086:generate_lead",
      category: "conversion_tracking",
      severity: "critical",
      confidenceScore: 85,
    });
    expect(drafts[0]!.observation).toContain("7-day period");
    expect(drafts[0]!.observation).toContain("last 7 days");
  });
});

describe("ga4-checks — runChecks conversion tracking gap (GA4 vs BOS's own lead data)", () => {
  beforeEach(() => {
    runReport.mockReset();
    fakeDb.clientsRows = [];
  });

  it("fires when GA4 shows 0 generate_lead events but BOS has real leads at/above the volume gate", async () => {
    mockGa4({ recentEventRows: [], previousSessionCount: 0, recentSessionCount: 0 });
    fakeDb.clientsRows = Array.from({ length: 12 }, (_, i) => ({ id: `client-${i}` }));

    const drafts = await runChecks("tenant-1", "524948086");

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      dedupeKey: "conversion_tracking_gap:524948086:generate_lead",
      category: "conversion_tracking",
      severity: "critical",
      confidenceScore: 85,
    });
    expect(drafts[0]!.evidence).toMatchObject({ recentLeadsCount: 12, windowDays: 7, ga4GenerateLeadCount: 0 });
  });

  it("does not fire below the volume gate, however clear the gap looks", async () => {
    mockGa4({ recentEventRows: [], previousSessionCount: 0, recentSessionCount: 0 });
    fakeDb.clientsRows = Array.from({ length: 9 }, (_, i) => ({ id: `client-${i}` }));

    const drafts = await runChecks("tenant-1", "524948086");

    expect(drafts).toHaveLength(0);
  });

  it("does not fire when GA4 already shows generate_lead events firing", async () => {
    mockGa4({ recentEventRows: [eventRow("generate_lead", 3)], previousSessionCount: 0, recentSessionCount: 0 });
    fakeDb.clientsRows = Array.from({ length: 20 }, (_, i) => ({ id: `client-${i}` }));

    const drafts = await runChecks("tenant-1", "524948086");

    expect(drafts).toHaveLength(0);
  });

  it("can fire alongside the event-stopped-firing check when both conditions are independently true", async () => {
    mockGa4({
      previousEventRows: [eventRow("generate_lead", 12)],
      recentEventRows: [],
      previousSessionCount: 0,
      recentSessionCount: 0,
    });
    fakeDb.clientsRows = Array.from({ length: 15 }, (_, i) => ({ id: `client-${i}` }));

    const drafts = await runChecks("tenant-1", "524948086");

    expect(drafts.map((d) => d.dedupeKey)).toEqual(
      expect.arrayContaining(["ga4_event_stopped:524948086:generate_lead", "conversion_tracking_gap:524948086:generate_lead"]),
    );
  });
});
