import { describe, expect, it, vi, beforeEach } from "vitest";

// Regression test for the wiring inside run-check.ts, not an end-to-end
// integration test — packages/core has no test-database strategy yet (see
// docs/PRODUCTION_ROADMAP.md Milestone 3), so @bos/db is fully mocked. The
// point of this test is to prove specific wiring facts survive future
// changes: (1) a google_ads_account linked resource actually reaches
// checks/google-ads-checks.ts, (2) the AI Analyst only runs for
// daily_audit/on_demand, never quick_check, and (3) the findings lifecycle
// (miss-tracking, auto-resolution, reopening) is wired to the right db calls.
//
// run-check.ts queries the `findings` table twice per run, in a fixed order:
// first the currently-open findings, then the recently-resolved reopen
// candidates. The mock below matches that call order rather than
// introspecting the real drizzle query builder (which would need to parse
// `and(eq(...), eq(...), gte(...))` objects) — call order is simpler and no
// more fragile than the table-identity matching this mock already relied on
// before this change.

const { fakeState, checkRunsTable, findingsTable, linkedResourcesTable } = vi.hoisted(() => {
  return {
    fakeState: {
      linkedResources: [] as Array<{ resourceType: string; externalId: string }>,
      openFindings: [] as Array<Record<string, unknown>>,
      resolvedFindings: [] as Array<Record<string, unknown>>,
      findingsQueryCount: 0,
      updateCalls: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
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
          if (table === findingsTable) {
            fakeState.findingsQueryCount += 1;
            return fakeState.findingsQueryCount === 1 ? fakeState.openFindings : fakeState.resolvedFindings;
          }
          return [];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          fakeState.updateCalls.push({ table, values });
          return [];
        },
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

const { runCheck, isNeverAutoResolved, isCoveredByRunType, isEligibleForMissTracking } = await import(
  "./run-check"
);

function openFinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "finding-1",
    category: "organic_traffic",
    missedCount: 0,
    evidence: { dedupeKey: "ga4_traffic_drop:524948086", propertyId: "524948086" },
    ...overrides,
  };
}

describe("run-check.ts wiring", () => {
  beforeEach(() => {
    fakeState.linkedResources = [];
    fakeState.openFindings = [];
    fakeState.resolvedFindings = [];
    fakeState.findingsQueryCount = 0;
    fakeState.updateCalls = [];
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

describe("findings lifecycle — miss tracking / auto-resolution / reopening", () => {
  beforeEach(() => {
    fakeState.linkedResources = [];
    fakeState.openFindings = [];
    fakeState.resolvedFindings = [];
    fakeState.findingsQueryCount = 0;
    fakeState.updateCalls = [];
    vi.clearAllMocks();
  });

  // 1. finding detected -> missedCount reset to 0 (re-confirm path)
  it("1: re-detecting an open finding sets missedCount back to 0", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [openFinding({ missedCount: 1 })];
    ga4RunChecks.mockResolvedValueOnce([
      {
        dedupeKey: "ga4_traffic_drop:524948086",
        category: "organic_traffic",
        nature: "technical_issue",
        severity: "medium",
        confidenceScore: 55,
        title: "Significant traffic drop",
        observation: "...",
        businessImpact: "...",
        financialImpact: null,
        recommendedActions: [],
        requiresApproval: false,
        evidence: { propertyId: "524948086" },
      },
    ]);

    await runCheck("tenant-1", "quick_check");

    const reconfirmCall = fakeState.updateCalls.find((c) => c.table === findingsTable && c.values.missedCount === 0);
    expect(reconfirmCall).toBeDefined();
    expect(reconfirmCall!.values).not.toHaveProperty("status");
  });

  // 2. first valid miss -> missedCount 0 -> 1, stays open
  it("2: a first valid miss increments missedCount to 1 without resolving", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [openFinding({ missedCount: 0 })];
    ga4RunChecks.mockResolvedValueOnce([]); // condition no longer detected this run

    await runCheck("tenant-1", "quick_check");

    const findingUpdates = fakeState.updateCalls.filter((c) => c.table === findingsTable);
    expect(findingUpdates).toHaveLength(1);
    expect(findingUpdates[0]!.values).toMatchObject({ missedCount: 1 });
    expect(findingUpdates[0]!.values).not.toHaveProperty("status");
  });

  // 3. second valid miss -> missedCount 2, resolved
  it("3: a second valid miss resolves the finding with resolvedAt set", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [openFinding({ missedCount: 1 })];
    ga4RunChecks.mockResolvedValueOnce([]);

    await runCheck("tenant-1", "quick_check");

    const findingUpdates = fakeState.updateCalls.filter((c) => c.table === findingsTable);
    expect(findingUpdates).toHaveLength(1);
    expect(findingUpdates[0]!.values).toMatchObject({
      status: "resolved",
      missedCount: 2,
    });
    expect(findingUpdates[0]!.values.resolvedAt).toBeInstanceOf(Date);
  });

  // 4. api_error for the resource -> missedCount/status untouched
  it("4: an api_error draft for the same resource blocks the miss (no update at all)", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [openFinding({ missedCount: 0 })];
    ga4RunChecks.mockRejectedValueOnce(new Error("GA4 API unavailable"));

    await runCheck("tenant-1", "quick_check");

    // The only update targeting the original finding would have to come
    // from the miss-tracking loop — there should be none, since the api_error
    // draft this run marks the resource as unverified.
    const missUpdate = fakeState.updateCalls.find(
      (c) => c.table === findingsTable && ("missedCount" in c.values || "status" in c.values),
    );
    expect(missUpdate).toBeUndefined();
  });

  // 5. resource inactive -> missedCount/status untouched
  it("5: a finding whose resource is no longer active is left untouched", async () => {
    fakeState.linkedResources = []; // resource deactivated/removed
    fakeState.openFindings = [openFinding({ missedCount: 0 })];

    await runCheck("tenant-1", "quick_check");

    expect(fakeState.updateCalls.filter((c) => c.table === findingsTable)).toHaveLength(0);
  });

  // 6. run_type not covering the dedupeKey -> untouched
  it("6: a claude:* finding is untouched by a quick_check run (not covered)", async () => {
    fakeState.linkedResources = [];
    fakeState.openFindings = [
      openFinding({
        category: "other",
        evidence: { dedupeKey: "claude:other:Some strategic note" },
      }),
    ];

    await runCheck("tenant-1", "quick_check");

    expect(fakeState.updateCalls.filter((c) => c.table === findingsTable)).toHaveLength(0);
  });

  // 10. detected again after one miss -> missedCount back to 0, stays open
  it("10: re-detecting a finding with missedCount 1 resets it to 0", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [openFinding({ missedCount: 1 })];
    ga4RunChecks.mockResolvedValueOnce([
      {
        dedupeKey: "ga4_traffic_drop:524948086",
        category: "organic_traffic",
        nature: "technical_issue",
        severity: "medium",
        confidenceScore: 55,
        title: "Significant traffic drop",
        observation: "...",
        businessImpact: "...",
        financialImpact: null,
        recommendedActions: [],
        requiresApproval: false,
        evidence: { propertyId: "524948086" },
      },
    ]);

    await runCheck("tenant-1", "quick_check");

    const findingUpdates = fakeState.updateCalls.filter((c) => c.table === findingsTable);
    expect(findingUpdates).toHaveLength(1);
    expect(findingUpdates[0]!.values).toMatchObject({ missedCount: 0 });
  });

  // 11. resolved finding reappears within 30 days -> reopen the same row
  it("11: a resolved finding rediscovered within 30 days is reopened, not duplicated", async () => {
    const resolvedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [];
    fakeState.resolvedFindings = [
      {
        id: "finding-1",
        category: "organic_traffic",
        evidence: { dedupeKey: "ga4_traffic_drop:524948086", propertyId: "524948086" },
        resolvedAt,
      },
    ];
    ga4RunChecks.mockResolvedValueOnce([
      {
        dedupeKey: "ga4_traffic_drop:524948086",
        category: "organic_traffic",
        nature: "technical_issue",
        severity: "medium",
        confidenceScore: 55,
        title: "Significant traffic drop",
        observation: "back again",
        businessImpact: "...",
        financialImpact: null,
        recommendedActions: [],
        requiresApproval: false,
        evidence: { propertyId: "524948086" },
      },
    ]);

    await runCheck("tenant-1", "quick_check");

    expect(createFinding).not.toHaveBeenCalled();
    const findingUpdates = fakeState.updateCalls.filter((c) => c.table === findingsTable);
    expect(findingUpdates).toHaveLength(1);
    expect(findingUpdates[0]!.values).toMatchObject({
      status: "open",
      resolvedAt: null,
      missedCount: 0,
    });
    // first_detected_at / checkRunId are simply absent from the update payload
    expect(findingUpdates[0]!.values).not.toHaveProperty("firstDetectedAt");
    expect(findingUpdates[0]!.values).not.toHaveProperty("checkRunId");
  });

  // 12. resolved finding reappears after >30 days -> new finding
  it("12: a resolved finding rediscovered after the reopen window creates a new finding", async () => {
    // Simulates the >30-day case by leaving resolvedFindings empty — the
    // real query filters by `resolvedAt >= now - 30d` at the DB level, so a
    // finding resolved earlier than that simply never appears in this array.
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [];
    fakeState.resolvedFindings = [];
    ga4RunChecks.mockResolvedValueOnce([
      {
        dedupeKey: "ga4_traffic_drop:524948086",
        category: "organic_traffic",
        nature: "technical_issue",
        severity: "medium",
        confidenceScore: 55,
        title: "Significant traffic drop",
        observation: "back again after a long time",
        businessImpact: "...",
        financialImpact: null,
        recommendedActions: [],
        requiresApproval: false,
        evidence: { propertyId: "524948086" },
      },
    ]);

    await runCheck("tenant-1", "quick_check");

    expect(createFinding).toHaveBeenCalledTimes(1);
    const statusUpdates = fakeState.updateCalls.filter((c) => c.values.status === "open");
    expect(statusUpdates).toHaveLength(0);
  });

  // 13. no duplicate finding when reopening
  it("13: reopening never also calls createFinding for the same draft", async () => {
    const resolvedAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.resolvedFindings = [
      {
        id: "finding-1",
        category: "organic_traffic",
        evidence: { dedupeKey: "ga4_traffic_drop:524948086", propertyId: "524948086" },
        resolvedAt,
      },
    ];
    ga4RunChecks.mockResolvedValueOnce([
      {
        dedupeKey: "ga4_traffic_drop:524948086",
        category: "organic_traffic",
        nature: "technical_issue",
        severity: "medium",
        confidenceScore: 55,
        title: "Significant traffic drop",
        observation: "back again",
        businessImpact: "...",
        financialImpact: null,
        recommendedActions: [],
        requiresApproval: false,
        evidence: { propertyId: "524948086" },
      },
    ]);

    await runCheck("tenant-1", "quick_check");

    expect(createFinding).not.toHaveBeenCalled();
  });

  // 14. no open and no recently-resolved match -> created normally
  it("14: a brand-new draft with no open or recently-resolved match creates a new finding", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [];
    fakeState.resolvedFindings = [];
    ga4RunChecks.mockResolvedValueOnce([
      {
        dedupeKey: "ga4_traffic_drop:524948086",
        category: "organic_traffic",
        nature: "technical_issue",
        severity: "medium",
        confidenceScore: 55,
        title: "Significant traffic drop",
        observation: "first time",
        businessImpact: "...",
        financialImpact: null,
        recommendedActions: [],
        requiresApproval: false,
        evidence: { propertyId: "524948086" },
      },
    ]);

    await runCheck("tenant-1", "quick_check");

    expect(createFinding).toHaveBeenCalledTimes(1);
  });
});

describe("findings lifecycle — pure decision functions", () => {
  it("isNeverAutoResolved: true for claude:*, gsc_indexing:*, gtm_no_live_version:*, api_error:*", () => {
    expect(isNeverAutoResolved("claude:organic_traffic:Some note")).toBe(true);
    expect(isNeverAutoResolved("gsc_indexing:https://bonolinitransfer.com/")).toBe(true);
    expect(isNeverAutoResolved("gtm_no_live_version:GTM-ABC123")).toBe(true);
    expect(isNeverAutoResolved("api_error:ga4_property:524948086")).toBe(true);
  });

  it("isNeverAutoResolved: false for the auto-resolvable deterministic prefixes", () => {
    expect(isNeverAutoResolved("ga4_traffic_drop:524948086")).toBe(false);
    expect(isNeverAutoResolved("gsc_click_drop:https://bonolinitransfer.com/")).toBe(false);
    expect(isNeverAutoResolved("landing_page_error:https://bonolinitransfer.com/")).toBe(false);
  });

  // 6 (unit-level companion): quick_check never covers claude:* — this is
  // the only real occurrence of "run_type doesn't cover this dedupeKey" in
  // the current matrix (every deterministic prefix is covered by all three
  // run_types).
  it("isCoveredByRunType: quick_check does not cover claude:*, daily_audit/on_demand do", () => {
    expect(isCoveredByRunType("claude:other:Some note", "quick_check")).toBe(false);
    expect(isCoveredByRunType("claude:other:Some note", "daily_audit")).toBe(true);
    expect(isCoveredByRunType("claude:other:Some note", "on_demand")).toBe(true);
  });

  it("isCoveredByRunType: deterministic prefixes are covered by every run_type", () => {
    for (const runType of ["quick_check", "daily_audit", "on_demand"] as const) {
      expect(isCoveredByRunType("ga4_traffic_drop:524948086", runType)).toBe(true);
      expect(isCoveredByRunType("gsc_indexing:https://x/", runType)).toBe(true);
    }
  });

  // 7. claude:* is never auto-resolved even when the run_type covers it
  it("7: isEligibleForMissTracking is false for claude:* even on daily_audit (covered but excluded)", () => {
    expect(
      isEligibleForMissTracking({
        dedupeKey: "claude:other:Some strategic note",
        runType: "daily_audit",
        evidence: {},
        draftsThisRun: [],
        activeResources: [],
      }),
    ).toBe(false);
  });

  // 8. gsc_indexing:* is never auto-resolved
  it("8: isEligibleForMissTracking is false for gsc_indexing:* even with the resource active", () => {
    expect(
      isEligibleForMissTracking({
        dedupeKey: "gsc_indexing:https://bonolinitransfer.com/",
        runType: "quick_check",
        evidence: { url: "https://bonolinitransfer.com/" },
        draftsThisRun: [],
        activeResources: [{ resourceType: "search_console_site", externalId: "https://bonolinitransfer.com/" }],
      }),
    ).toBe(false);
  });

  // 9. gtm_no_live_version is never auto-resolved
  it("9: isEligibleForMissTracking is false for gtm_no_live_version even with the resource active", () => {
    expect(
      isEligibleForMissTracking({
        dedupeKey: "gtm_no_live_version:GTM-ABC123",
        runType: "quick_check",
        evidence: { publicContainerId: "GTM-ABC123" },
        draftsThisRun: [],
        activeResources: [{ resourceType: "gtm_container", externalId: "GTM-ABC123" }],
      }),
    ).toBe(false);
  });

  it("4 (unit-level companion): isEligibleForMissTracking is false when an api_error draft exists for the resource", () => {
    expect(
      isEligibleForMissTracking({
        dedupeKey: "ga4_traffic_drop:524948086",
        runType: "quick_check",
        evidence: { propertyId: "524948086" },
        draftsThisRun: [{ dedupeKey: "api_error:ga4_property:524948086" } as never],
        activeResources: [{ resourceType: "ga4_property", externalId: "524948086" }],
      }),
    ).toBe(false);
  });

  it("5 (unit-level companion): isEligibleForMissTracking is false when the resource is not active", () => {
    expect(
      isEligibleForMissTracking({
        dedupeKey: "ga4_traffic_drop:524948086",
        runType: "quick_check",
        evidence: { propertyId: "524948086" },
        draftsThisRun: [],
        activeResources: [],
      }),
    ).toBe(false);
  });

  it("isEligibleForMissTracking is true for a covered, active, error-free deterministic finding", () => {
    expect(
      isEligibleForMissTracking({
        dedupeKey: "ga4_traffic_drop:524948086",
        runType: "quick_check",
        evidence: { propertyId: "524948086" },
        draftsThisRun: [],
        activeResources: [{ resourceType: "ga4_property", externalId: "524948086" }],
      }),
    ).toBe(true);
  });

  it("isEligibleForMissTracking is true for non-resource checks (website/attribution) regardless of resources", () => {
    expect(
      isEligibleForMissTracking({
        dedupeKey: "attribution_untagged_ratio:tenant-1",
        runType: "quick_check",
        evidence: {},
        draftsThisRun: [],
        activeResources: [],
      }),
    ).toBe(true);
    expect(
      isEligibleForMissTracking({
        dedupeKey: "landing_page_slow:https://bonolinitransfer.com/",
        runType: "quick_check",
        evidence: {},
        draftsThisRun: [],
        activeResources: [],
      }),
    ).toBe(true);
  });
});
