import { describe, expect, it, vi, beforeEach } from "vitest";

// Regression test for the wiring inside run-check.ts, not an end-to-end
// integration test — packages/core has no test-database strategy yet (see
// docs/PRODUCTION_ROADMAP.md Milestone 3), so @bos/db is fully mocked. The
// point of this test is to prove two specific wiring facts survive future
// changes: (1) a google_ads_account linked resource actually reaches
// checks/google-ads-checks.ts, and (2) the AI Analyst only runs for
// daily_audit/on_demand, never quick_check — exactly the behavior this
// integration was required to preserve.

const { fakeState, checkRunsTable, findingsTable, linkedResourcesTable } = vi.hoisted(() => {
  return {
    fakeState: {
      linkedResources: [] as Array<{ resourceType: string; externalId: string }>,
      openFindings: [] as Array<{ id: string; category: string; evidence: unknown }>,
    },
    checkRunsTable: { __name: "checkRuns" },
    findingsTable: { __name: "findings" },
    linkedResourcesTable: { __name: "marketingLinkedResources" },
  };
});

vi.mock("@bos/db", () => {
  const db = {
    insert: (table: unknown) => ({
      values: () => ({
        returning: async () => {
          if (table === checkRunsTable) return [{ id: "run-1" }];
          return [{ id: "row-1" }];
        },
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === linkedResourcesTable) return fakeState.linkedResources;
          if (table === findingsTable) return fakeState.openFindings;
          return [];
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => [],
      }),
    }),
  };

  return {
    checkRuns: checkRunsTable,
    findings: findingsTable,
    marketingLinkedResources: linkedResourcesTable,
    assertOne: (rows: unknown[]) => rows[0],
    getDb: () => db,
  };
});

const websiteChecksRunChecks = vi.fn().mockResolvedValue([]);
const ga4RunChecks = vi.fn().mockResolvedValue([]);
const gtmRunChecks = vi.fn().mockResolvedValue([]);
const searchConsoleRunChecks = vi.fn().mockResolvedValue([]);
const attributionRunChecks = vi.fn().mockResolvedValue([]);
const googleAdsRunChecks = vi.fn().mockResolvedValue([]);
const runGoogleMarketingAnalyst = vi.fn().mockResolvedValue([]);
const createFinding = vi.fn().mockResolvedValue({});
const recordHealthScoreSnapshot = vi.fn().mockResolvedValue({});
const sendCriticalAlertEmail = vi.fn().mockResolvedValue(undefined);

vi.mock("./checks/website-checks", () => ({ runChecks: (...a: unknown[]) => websiteChecksRunChecks(...a) }));
vi.mock("./checks/ga4-checks", () => ({ runChecks: (...a: unknown[]) => ga4RunChecks(...a) }));
vi.mock("./checks/gtm-checks", () => ({ runChecks: (...a: unknown[]) => gtmRunChecks(...a) }));
vi.mock("./checks/search-console-checks", () => ({
  runChecks: (...a: unknown[]) => searchConsoleRunChecks(...a),
}));
vi.mock("./checks/attribution-checks", () => ({ runChecks: (...a: unknown[]) => attributionRunChecks(...a) }));
vi.mock("./checks/google-ads-checks", () => ({ runChecks: (...a: unknown[]) => googleAdsRunChecks(...a) }));
vi.mock("./ai-analyst", () => ({ runGoogleMarketingAnalyst: (...a: unknown[]) => runGoogleMarketingAnalyst(...a) }));
vi.mock("./service", () => ({
  createFinding: (...a: unknown[]) => createFinding(...a),
  recordHealthScoreSnapshot: (...a: unknown[]) => recordHealthScoreSnapshot(...a),
}));
vi.mock("./alerts", () => ({ sendCriticalAlertEmail: (...a: unknown[]) => sendCriticalAlertEmail(...a) }));

const { runCheck } = await import("./run-check");

describe("run-check.ts wiring", () => {
  beforeEach(() => {
    fakeState.linkedResources = [];
    fakeState.openFindings = [];
    vi.clearAllMocks();
  });

  it("dispatches a google_ads_account linked resource to checks/google-ads-checks.ts", async () => {
    fakeState.linkedResources = [{ resourceType: "google_ads_account", externalId: "123-456-7890" }];

    await runCheck("tenant-1", "on_demand");

    expect(googleAdsRunChecks).toHaveBeenCalledWith("tenant-1", "123-456-7890");
    expect(ga4RunChecks).not.toHaveBeenCalled();
  });

  it("does not invoke the AI Analyst on quick_check", async () => {
    fakeState.linkedResources = [];

    await runCheck("tenant-1", "quick_check");

    expect(runGoogleMarketingAnalyst).not.toHaveBeenCalled();
  });

  it("invokes the AI Analyst on daily_audit", async () => {
    fakeState.linkedResources = [];

    await runCheck("tenant-1", "daily_audit");

    expect(runGoogleMarketingAnalyst).toHaveBeenCalledTimes(1);
  });

  it("invokes the AI Analyst on on_demand", async () => {
    fakeState.linkedResources = [];

    await runCheck("tenant-1", "on_demand", "user-1");

    expect(runGoogleMarketingAnalyst).toHaveBeenCalledWith("tenant-1", expect.any(Array), "user-1");
  });
});
