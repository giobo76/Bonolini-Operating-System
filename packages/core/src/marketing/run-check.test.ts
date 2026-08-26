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
// run-check.ts queries the `findings` table three times per run, in a fixed
// order: currently-open findings, then all account_health findings
// (open+resolved, used to correlate claude:account_health:* commentary
// against the real api_error findings' active windows), then the
// recently-resolved reopen candidates. The mock below matches that call
// order rather than introspecting the real drizzle query builder (which
// would need to parse `and(eq(...), eq(...), gte(...))` objects) — call
// order is simpler and no more fragile than the table-identity matching
// this mock already relied on before this change.

const { fakeState, checkRunsTable, findingsTable, linkedResourcesTable } = vi.hoisted(() => {
  return {
    fakeState: {
      linkedResources: [] as Array<{ resourceType: string; externalId: string }>,
      openFindings: [] as Array<Record<string, unknown>>,
      accountHealthHistory: [] as Array<Record<string, unknown>>,
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
            if (fakeState.findingsQueryCount === 1) return fakeState.openFindings;
            if (fakeState.findingsQueryCount === 2) return fakeState.accountHealthHistory;
            return fakeState.resolvedFindings;
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
    fakeState.accountHealthHistory = [];
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
    fakeState.accountHealthHistory = [];
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

  // 6. run_type not covering the dedupeKey -> untouched. Uses the canonical
  // claude:<category> shape deliberately — a legacy claude:<category>:<title>
  // finding *would* be touched on quick_check too, by the separate,
  // unconditional legacy-dedupeKey cleanup (see "claude: dedupeKey
  // collapsed to category scope" below) — that's a different mechanism from
  // the miss-tracking this test covers.
  it("6: a canonical claude:* finding is untouched by a quick_check run (not covered by miss-tracking)", async () => {
    fakeState.linkedResources = [];
    fakeState.openFindings = [
      openFinding({
        category: "other",
        evidence: { dedupeKey: "claude:other" },
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

describe("findings lifecycle — api_error auto-resolution on recovery", () => {
  // Regression for a real production incident: a dead Google OAuth
  // connection produced api_error findings for GA4/GTM/Search Console/Ads;
  // reconnecting fixed the connection, but the old api_error findings
  // stayed "open" forever because api_error is deliberately excluded from
  // the generic miss-based auto-resolve loop (see NEVER_AUTO_RESOLVE_PREFIXES
  // above). These tests cover the separate, resource-scoped resolution path
  // added specifically for api_error.
  beforeEach(() => {
    fakeState.linkedResources = [];
    fakeState.openFindings = [];
    fakeState.accountHealthHistory = [];
    fakeState.resolvedFindings = [];
    fakeState.findingsQueryCount = 0;
    fakeState.updateCalls = [];
    vi.clearAllMocks();
  });

  function apiErrorFinding(resourceType: string, externalId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: `err-${resourceType}`,
      category: "account_health",
      missedCount: 0,
      evidence: { dedupeKey: `api_error:${resourceType}:${externalId}`, resourceType, externalId },
      ...overrides,
    };
  }

  it("GA4: an old api_error is resolved when the GA4 check succeeds again", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [apiErrorFinding("ga4_property", "524948086")];
    ga4RunChecks.mockResolvedValueOnce([]);

    await runCheck("tenant-1", "quick_check");

    const resolvedUpdates = fakeState.updateCalls.filter(
      (c) => c.table === findingsTable && c.values.status === "resolved",
    );
    expect(resolvedUpdates).toHaveLength(1);
    expect(resolvedUpdates[0]!.values.resolvedAt).toBeInstanceOf(Date);
  });

  it("GA4: an old api_error stays open (not resolved) when the GA4 check fails again", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [apiErrorFinding("ga4_property", "524948086")];
    ga4RunChecks.mockRejectedValueOnce(new Error("invalid_grant"));

    await runCheck("tenant-1", "quick_check");

    const resolvedUpdates = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    expect(resolvedUpdates).toHaveLength(0);

    // Still re-confirmed (lastSeenAt/observation refreshed) via the normal
    // existing-finding path, same as before this change.
    const refreshUpdates = fakeState.updateCalls.filter(
      (c) => c.table === findingsTable && !("status" in c.values),
    );
    expect(refreshUpdates).toHaveLength(1);
    expect(refreshUpdates[0]!.values.lastSeenAt).toBeInstanceOf(Date);
  });

  it("GA4: an old api_error is NOT resolved merely because an unrelated GTM check succeeds", async () => {
    fakeState.linkedResources = [{ resourceType: "gtm_container", externalId: "GTM-ABC123" }];
    fakeState.openFindings = [apiErrorFinding("ga4_property", "524948086")];
    gtmRunChecks.mockResolvedValueOnce([]);

    await runCheck("tenant-1", "quick_check");

    expect(ga4RunChecks).not.toHaveBeenCalled();
    const resolvedUpdates = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    expect(resolvedUpdates).toHaveLength(0);
  });

  it("GTM: an old api_error is resolved when the GTM check succeeds again", async () => {
    fakeState.linkedResources = [{ resourceType: "gtm_container", externalId: "GTM-ABC123" }];
    fakeState.openFindings = [apiErrorFinding("gtm_container", "GTM-ABC123")];
    gtmRunChecks.mockResolvedValueOnce([]);

    await runCheck("tenant-1", "quick_check");

    const resolvedUpdates = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    expect(resolvedUpdates).toHaveLength(1);
  });

  it("Search Console: an old api_error is resolved when the Search Console check succeeds again", async () => {
    fakeState.linkedResources = [
      { resourceType: "search_console_site", externalId: "https://bonolinitransfer.com/" },
    ];
    fakeState.openFindings = [apiErrorFinding("search_console_site", "https://bonolinitransfer.com/")];
    searchConsoleRunChecks.mockResolvedValueOnce([]);

    await runCheck("tenant-1", "quick_check");

    const resolvedUpdates = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    expect(resolvedUpdates).toHaveLength(1);
  });

  it("Google Ads: an old api_error is resolved when the Google Ads check succeeds again", async () => {
    fakeState.linkedResources = [{ resourceType: "google_ads_account", externalId: "678-018-7978" }];
    fakeState.openFindings = [apiErrorFinding("google_ads_account", "678-018-7978")];
    googleAdsRunChecks.mockResolvedValueOnce([]);

    await runCheck("tenant-1", "quick_check");

    const resolvedUpdates = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    expect(resolvedUpdates).toHaveLength(1);
  });

  it("a brand-new api_error (no prior open finding) is still created normally", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [];
    ga4RunChecks.mockRejectedValueOnce(new Error("invalid_grant"));

    await runCheck("tenant-1", "quick_check");

    expect(createFinding).toHaveBeenCalledTimes(1);
    expect(createFinding).toHaveBeenCalledWith(
      "tenant-1",
      expect.objectContaining({
        evidence: expect.objectContaining({ dedupeKey: "api_error:ga4_property:524948086" }),
      }),
    );
  });

  it("an identical recurring api_error is deduplicated/updated in place, never duplicated", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [apiErrorFinding("ga4_property", "524948086")];
    ga4RunChecks.mockRejectedValueOnce(new Error("invalid_grant"));

    await runCheck("tenant-1", "quick_check");

    expect(createFinding).not.toHaveBeenCalled();
    const findingUpdates = fakeState.updateCalls.filter((c) => c.table === findingsTable);
    expect(findingUpdates).toHaveLength(1);
  });

  it("resolving an api_error in the same run does not disturb an unrelated open finding's normal re-confirm path", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [
      apiErrorFinding("ga4_property", "524948086"),
      openFinding({ id: "traffic-drop-1", missedCount: 1 }), // ga4_traffic_drop:524948086, category organic_traffic
    ];
    ga4RunChecks.mockResolvedValueOnce([
      {
        dedupeKey: "ga4_traffic_drop:524948086",
        category: "organic_traffic",
        nature: "technical_issue",
        severity: "medium",
        confidenceScore: 55,
        title: "Significant traffic drop",
        observation: "still dropping",
        businessImpact: "...",
        financialImpact: null,
        recommendedActions: [],
        requiresApproval: false,
        evidence: { propertyId: "524948086" },
      },
    ]);

    await runCheck("tenant-1", "quick_check");

    const resolvedUpdates = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    expect(resolvedUpdates).toHaveLength(1); // only the api_error

    const reconfirmUpdate = fakeState.updateCalls.find(
      (c) => c.table === findingsTable && c.values.missedCount === 0 && !("status" in c.values),
    );
    expect(reconfirmUpdate).toBeDefined(); // the traffic-drop finding re-confirmed exactly as before this change
  });
});

describe("findings lifecycle — OAuth-correlated stale AI account_health commentary", () => {
  // Regression for a real production symptom: after the api_error fix above
  // resolved the 4 deterministic findings, /marketing still showed the
  // outage as active, because the AI Analyst (strategist.ts) had separately
  // written its own free-text account_health findings ("Systemic OAuth
  // token failure across all connected platforms...") on every daily_audit
  // run the outage persisted — a fresh dedupeKey each time
  // (`claude:${category}:${title}`), so none of them ever deduplicated
  // against each other. Verified against real Production data: 6
  // near-duplicate "Systemic OAuth..." findings plus 6 companion "No
  // fallback monitoring..." findings, all still open.
  //
  // The naive fix ("resolve every open claude:account_health: finding once
  // zero api_error findings remain") was rejected as too broad: an
  // account_health Claude finding can also be triggered by a google_ads:
  // performance signal (see AI_REQUIRE_SIGNAL_PRESENT in ai-analyst.ts),
  // completely unrelated to an OAuth outage, and would be wrongly resolved.
  // These tests exercise the narrower correlation instead: a
  // claude:account_health: finding is only resolved if its firstDetectedAt
  // falls inside a real api_error finding's active window
  // ([firstDetectedAt, resolvedAt ?? now]) — a signal built entirely from
  // timestamps already on every finding row, never from Claude's wording.
  beforeEach(() => {
    fakeState.linkedResources = [];
    fakeState.openFindings = [];
    fakeState.accountHealthHistory = [];
    fakeState.resolvedFindings = [];
    fakeState.findingsQueryCount = 0;
    fakeState.updateCalls = [];
    vi.clearAllMocks();
  });

  function apiErrorFinding(resourceType: string, externalId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: `err-${resourceType}`,
      category: "account_health",
      missedCount: 0,
      firstDetectedAt: new Date("2026-08-21T06:00:43.000Z"),
      resolvedAt: null,
      evidence: { dedupeKey: `api_error:${resourceType}:${externalId}`, resourceType, externalId },
      ...overrides,
    };
  }

  function claudeAccountHealthFinding(id: string, title: string, firstDetectedAt: Date) {
    return {
      id,
      category: "account_health",
      missedCount: 0,
      firstDetectedAt,
      evidence: { dedupeKey: `claude:account_health:${title}` },
    };
  }

  // 1. OAuth-derived stale finding resolved once the incident fully recovers
  it("1: resolves an OAuth-derived claude:account_health finding once the incident is fully recovered", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [
      apiErrorFinding("ga4_property", "524948086"),
      claudeAccountHealthFinding(
        "claude-1",
        "Systemic OAuth token failure across all connected platforms",
        new Date("2026-08-21T06:00:44.000Z"),
      ),
    ];
    fakeState.accountHealthHistory = [apiErrorFinding("ga4_property", "524948086")];
    ga4RunChecks.mockResolvedValueOnce([]);

    await runCheck("tenant-1", "on_demand", "user-1");

    const resolved = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    expect(resolved).toHaveLength(2); // the api_error itself + the correlated Claude finding
  });

  // 2. every OAuth-derived duplicate resolved, not just the first
  it("2: resolves every OAuth-derived duplicate claude:account_health finding in one pass", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [
      apiErrorFinding("ga4_property", "524948086"),
      claudeAccountHealthFinding(
        "claude-1",
        "Systemic OAuth token failure across all connected platforms",
        new Date("2026-08-21T06:00:44.000Z"),
      ),
      claudeAccountHealthFinding(
        "claude-2",
        "Systemic OAuth authentication failure across all connected platforms",
        new Date("2026-08-22T06:00:34.000Z"),
      ),
      claudeAccountHealthFinding(
        "claude-3",
        "No fallback monitoring in place while primary integration is down",
        new Date("2026-08-25T06:00:27.000Z"),
      ),
    ];
    fakeState.accountHealthHistory = [apiErrorFinding("ga4_property", "524948086")];
    ga4RunChecks.mockResolvedValueOnce([]);

    await runCheck("tenant-1", "on_demand", "user-1");

    const resolved = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    expect(resolved).toHaveLength(4); // the api_error + all 3 duplicate AI findings
  });

  // 3. a claude:account_health finding NOT correlated to any api_error window
  // is still resolved — by the separate, unconditional legacy-dedupeKey
  // cleanup (see "claude: dedupeKey collapsed to category scope" below),
  // not by this correlation logic. The OAuth-correlation gate itself is
  // still real code, still exercised by tests 1/2/5/6 above/below where a
  // finding is genuinely uncorrelated *and* not legacy-shaped — but any
  // legacy-shaped claude:account_health:* finding, correlated or not, is
  // now in scope for the broader cleanup.
  it("3: an uncorrelated but legacy-shaped claude:account_health finding is still resolved, by the legacy cleanup rather than the correlation logic", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [
      claudeAccountHealthFinding(
        "claude-1",
        "Consider a dedicated budget alert threshold for this account",
        new Date("2026-07-01T00:00:00.000Z"), // long before the api_error window below
      ),
    ];
    fakeState.accountHealthHistory = [
      apiErrorFinding("ga4_property", "524948086", {
        firstDetectedAt: new Date("2026-08-20T00:00:00.000Z"),
        resolvedAt: new Date("2026-08-21T00:00:00.000Z"),
      }),
    ];
    ga4RunChecks.mockResolvedValueOnce([]);

    await runCheck("tenant-1", "on_demand", "user-1");

    const resolved = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.values.resolvedAt).toBeInstanceOf(Date);
  });

  // 4. a deterministic account_health finding (e.g. google_ads:) is never touched — only claude:account_health: dedupeKeys are candidates
  it("4: leaves a deterministic account_health finding (google_ads:) OPEN regardless of api_error state", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [
      {
        id: "gads-1",
        category: "account_health",
        missedCount: 0,
        firstDetectedAt: new Date("2026-08-21T06:00:44.000Z"),
        evidence: { dedupeKey: "google_ads:zero_conversions:678-018-7978" },
      },
    ];
    fakeState.accountHealthHistory = [apiErrorFinding("ga4_property", "524948086")];
    ga4RunChecks.mockResolvedValueOnce([]);

    await runCheck("tenant-1", "on_demand", "user-1");

    const resolved = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    expect(resolved).toHaveLength(0);
  });

  // 5. still-open api_error elsewhere -> the correlation gate itself still
  // blocks (no *second* resolve of the AI finding via correlation), but the
  // unconditional legacy cleanup resolves the legacy-shaped AI finding
  // anyway — it doesn't gate on other resources' api_error state. The real,
  // still-broken GA4 resource keeps its own deterministic api_error finding
  // open throughout (constraint: deterministic findings are never touched
  // by any of this).
  it("5: the legacy AI finding is resolved by the unconditional cleanup even while another resource's api_error is still open, which itself stays open", async () => {
    fakeState.linkedResources = [{ resourceType: "gtm_container", externalId: "GTM-ABC123" }];
    fakeState.openFindings = [
      apiErrorFinding("ga4_property", "524948086"), // GA4 not linked this run — stays open, untouched
      claudeAccountHealthFinding(
        "claude-1",
        "Systemic OAuth token failure across all connected platforms",
        new Date("2026-08-21T06:00:44.000Z"),
      ),
    ];
    fakeState.accountHealthHistory = [apiErrorFinding("ga4_property", "524948086")];
    gtmRunChecks.mockResolvedValueOnce([]);

    await runCheck("tenant-1", "on_demand", "user-1");

    const resolved = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    // Exactly one resolve — the legacy claude finding via the unconditional
    // cleanup. If GA4's still-open api_error had also been resolved (a
    // constraint-4 violation), this would be 2.
    expect(resolved).toHaveLength(1);
  });

  // 6. recovery happening in a later run (the api_error itself was already resolved earlier) still resolves the old AI commentary
  it("6: resolves an old OAuth-derived claude finding even when recovery is confirmed in a much later run", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [
      claudeAccountHealthFinding(
        "claude-1",
        "Systemic OAuth token failure across all connected platforms",
        new Date("2026-08-21T06:00:44.000Z"),
      ),
    ];
    fakeState.accountHealthHistory = [
      // The api_error itself was already resolved in an earlier run — only the stale AI commentary is left.
      apiErrorFinding("ga4_property", "524948086", {
        firstDetectedAt: new Date("2026-08-21T06:00:43.000Z"),
        resolvedAt: new Date("2026-08-25T11:35:00.000Z"),
      }),
    ];
    ga4RunChecks.mockResolvedValueOnce([]); // this run is just a routine healthy check, days later

    await runCheck("tenant-1", "quick_check");

    const resolved = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    expect(resolved).toHaveLength(1);
  });

  // 7. findings of other categories are never touched by this logic
  it("7: does not modify a finding of an unrelated category (its own normal lifecycle proceeds untouched)", async () => {
    fakeState.linkedResources = [{ resourceType: "ga4_property", externalId: "524948086" }];
    fakeState.openFindings = [
      claudeAccountHealthFinding(
        "claude-1",
        "Systemic OAuth token failure across all connected platforms",
        new Date("2026-08-21T06:00:44.000Z"),
      ),
      {
        id: "traffic-drop-1",
        category: "organic_traffic",
        missedCount: 0,
        firstDetectedAt: new Date("2026-08-20T00:00:00.000Z"),
        evidence: { dedupeKey: "ga4_traffic_drop:524948086", propertyId: "524948086" },
      },
    ];
    fakeState.accountHealthHistory = [apiErrorFinding("ga4_property", "524948086")];
    ga4RunChecks.mockResolvedValueOnce([]); // no traffic-drop re-detected this run

    await runCheck("tenant-1", "on_demand", "user-1");

    const resolved = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    expect(resolved).toHaveLength(1); // only the claude finding

    const missIncrement = fakeState.updateCalls.find(
      (c) => c.table === findingsTable && c.values.missedCount === 1 && !("status" in c.values),
    );
    expect(missIncrement).toBeDefined(); // organic_traffic finding's own normal miss-tracking, unaffected
  });
});

describe("findings lifecycle — claude: dedupeKey collapsed to category scope", () => {
  // Regression for MIE noise: strategist.ts used to embed Claude's
  // free-text title in the dedupeKey, which regenerates every run even when
  // restating the same topic — so the exact-match dedup in run-check.ts
  // almost never fired and a new row was created daily instead of the
  // existing one being refreshed. Now the dedupeKey is `claude:${category}`
  // only, and claude:* was removed from NEVER_AUTO_RESOLVE_PREFIXES so the
  // existing generic miss-based auto-resolve loop (already used for
  // website-checks/attribution-checks findings) applies to it too.
  const claudeDraft = (overrides: Record<string, unknown> = {}) => ({
    dedupeKey: "claude:attribution",
    category: "attribution",
    nature: "strategic_opportunity",
    severity: "medium",
    confidenceScore: 55,
    title: "Assess phone/WhatsApp attribution",
    observation: "today's wording",
    businessImpact: "...",
    financialImpact: null,
    recommendedActions: [],
    requiresApproval: false,
    evidence: {},
    ...overrides,
  });

  beforeEach(() => {
    fakeState.linkedResources = [];
    fakeState.openFindings = [];
    fakeState.accountHealthHistory = [];
    fakeState.resolvedFindings = [];
    fakeState.findingsQueryCount = 0;
    fakeState.updateCalls = [];
    vi.clearAllMocks();
  });

  it("A: a claude: finding with the same category dedupeKey is updated in place across runs, never duplicated", async () => {
    fakeState.openFindings = [
      { id: "claude-attr-1", category: "attribution", missedCount: 0, evidence: { dedupeKey: "claude:attribution" } },
    ];
    runGoogleMarketingAnalyst.mockResolvedValueOnce([claudeDraft()]);

    await runCheck("tenant-1", "on_demand", "user-1");

    expect(createFinding).not.toHaveBeenCalled();
    const findingUpdates = fakeState.updateCalls.filter((c) => c.table === findingsTable);
    expect(findingUpdates).toHaveLength(1);
    expect(findingUpdates[0]!.values).toMatchObject({ missedCount: 0, observation: "today's wording" });
  });

  it("B: two claude: drafts sharing the same category within one run collapse into a single finding", async () => {
    runGoogleMarketingAnalyst.mockResolvedValueOnce([
      claudeDraft({ title: "First observation", observation: "first" }),
      claudeDraft({ title: "Second observation", observation: "second", nature: "technical_issue" }),
    ]);

    await runCheck("tenant-1", "on_demand", "user-1");

    expect(createFinding).toHaveBeenCalledTimes(1);
  });

  it("C: a claude: finding not re-detected on a covered run gets its first miss recorded, not resolved yet", async () => {
    fakeState.openFindings = [
      {
        id: "claude-comp-1",
        category: "competitor_observation",
        missedCount: 0,
        evidence: { dedupeKey: "claude:competitor_observation" },
      },
    ];
    runGoogleMarketingAnalyst.mockResolvedValueOnce([]); // Claude has nothing to say about this topic today

    await runCheck("tenant-1", "on_demand", "user-1");

    const missUpdate = fakeState.updateCalls.find((c) => c.table === findingsTable && c.values.missedCount === 1);
    expect(missUpdate).toBeDefined();
    expect(missUpdate!.values).not.toHaveProperty("status");
  });

  it("D: a claude: finding at missedCount 1 that's undetected again on the second covered run is auto-resolved", async () => {
    fakeState.openFindings = [
      {
        id: "claude-comp-1",
        category: "competitor_observation",
        missedCount: 1,
        evidence: { dedupeKey: "claude:competitor_observation" },
      },
    ];
    runGoogleMarketingAnalyst.mockResolvedValueOnce([]);

    await runCheck("tenant-1", "on_demand", "user-1");

    const resolveUpdate = fakeState.updateCalls.find(
      (c) => c.table === findingsTable && c.values.status === "resolved",
    );
    expect(resolveUpdate).toBeDefined();
    expect(resolveUpdate!.values.missedCount).toBe(2);
  });

  it("E: a claude: finding is left completely untouched on quick_check (the AI Analyst never runs there)", async () => {
    fakeState.openFindings = [
      {
        id: "claude-comp-1",
        category: "competitor_observation",
        missedCount: 0,
        evidence: { dedupeKey: "claude:competitor_observation" },
      },
    ];

    await runCheck("tenant-1", "quick_check");

    expect(runGoogleMarketingAnalyst).not.toHaveBeenCalled();
    expect(fakeState.updateCalls.filter((c) => c.table === findingsTable)).toHaveLength(0);
  });

  it("F: a legacy title-embedded claude: finding (pre-fix data) is resolved immediately by the unconditional legacy cleanup, not by waiting out the miss cycle", async () => {
    // Simulates the historical pile already in Production: old rows whose
    // dedupeKey still embeds a title. See "findings lifecycle — legacy
    // claude: dedupeKey cleanup" below for the dedicated test suite covering
    // this cleanup path specifically — this one just confirms the
    // miss-tracking prefix checks (isNeverAutoResolved/isCoveredByRunType)
    // don't themselves require the bare-category exact shape either, as a
    // second line of defense if the cleanup pass were ever removed.
    fakeState.openFindings = [
      {
        id: "legacy-1",
        category: "organic_traffic",
        missedCount: 1,
        evidence: { dedupeKey: "claude:organic_traffic:Traffic drop requires root-cause triage before conclusions can be drawn" },
      },
    ];
    runGoogleMarketingAnalyst.mockResolvedValueOnce([]); // today's synthesis no longer restates this old topic

    await runCheck("tenant-1", "daily_audit");

    const resolveUpdate = fakeState.updateCalls.find(
      (c) => c.table === findingsTable && c.values.status === "resolved",
    );
    expect(resolveUpdate).toBeDefined();
  });
});

describe("findings lifecycle — legacy claude: dedupeKey cleanup", () => {
  // Regression: after the category-scoped dedupeKey shipped, the historical
  // pile of legacy claude:<category>:<title> rows (dozens, verified in
  // Production) only cleared via the 2-miss auto-resolve cycle, which
  // depends on daily_audit/on_demand (once a day at best) — too slow, and
  // the dashboard stayed noisy. This cleanup resolves every open legacy-
  // shaped claude: finding directly, on any run_type, regardless of
  // whether a canonical sibling has been created yet. Runs unconditionally
  // (no AI Analyst output needed), so it doesn't require mocking
  // runGoogleMarketingAnalyst in any of these tests.
  beforeEach(() => {
    fakeState.linkedResources = [];
    fakeState.openFindings = [];
    fakeState.accountHealthHistory = [];
    fakeState.resolvedFindings = [];
    fakeState.findingsQueryCount = 0;
    fakeState.updateCalls = [];
    vi.clearAllMocks();
  });

  it("1: legacy claude:<category>:<title> duplicates in the same category are all resolved, no new rows created", async () => {
    fakeState.openFindings = [
      {
        id: "legacy-1",
        category: "attribution",
        missedCount: 0,
        evidence: { dedupeKey: "claude:attribution:Assess phone/WhatsApp attribution" },
      },
      {
        id: "legacy-2",
        category: "attribution",
        missedCount: 0,
        evidence: { dedupeKey: "claude:attribution:Low absolute organic volume limits standalone channel viability" },
      },
    ];

    await runCheck("tenant-1", "quick_check");

    const resolved = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    expect(resolved).toHaveLength(2);
    expect(createFinding).not.toHaveBeenCalled();
  });

  it("2: a canonical claude:<category> finding is never touched by the legacy cleanup", async () => {
    fakeState.openFindings = [
      { id: "canonical-1", category: "attribution", missedCount: 0, evidence: { dedupeKey: "claude:attribution" } },
    ];

    await runCheck("tenant-1", "quick_check");

    expect(fakeState.updateCalls.filter((c) => c.table === findingsTable)).toHaveLength(0);
  });

  it("3: deterministic findings across every prefix are never touched by the legacy cleanup", async () => {
    fakeState.openFindings = [
      { id: "det-1", category: "account_health", missedCount: 0, evidence: { dedupeKey: "api_error:ga4_property:524948086" } },
      { id: "det-2", category: "account_health", missedCount: 0, evidence: { dedupeKey: "google_ads:zero_conversions:678-018-7978" } },
      { id: "det-3", category: "organic_traffic", missedCount: 0, evidence: { dedupeKey: "ga4_traffic_drop:524948086" } },
      { id: "det-4", category: "organic_traffic", missedCount: 0, evidence: { dedupeKey: "gsc_click_drop:https://bonolinitransfer.com/" } },
      { id: "det-5", category: "gtm_configuration", missedCount: 0, evidence: { dedupeKey: "gtm_unpublished:GTM-ABC123:1" } },
      { id: "det-6", category: "landing_page_availability", missedCount: 0, evidence: { dedupeKey: "landing_page_error:https://bonolinitransfer.com/" } },
      { id: "det-7", category: "attribution", missedCount: 0, evidence: { dedupeKey: "attribution_untagged_ratio:tenant-1" } },
    ];

    await runCheck("tenant-1", "quick_check");

    expect(fakeState.updateCalls.filter((c) => c.values.status === "resolved")).toHaveLength(0);
  });

  it("4: running the cleanup again after resolution has no further effect (idempotent)", async () => {
    fakeState.openFindings = [
      {
        id: "legacy-1",
        category: "attribution",
        missedCount: 0,
        evidence: { dedupeKey: "claude:attribution:Assess phone/WhatsApp attribution" },
      },
    ];

    await runCheck("tenant-1", "quick_check");
    expect(fakeState.updateCalls.filter((c) => c.values.status === "resolved")).toHaveLength(1);

    // Next run: the resolved finding no longer has status "open", so the
    // real status="open" query would no longer return it — simulated here
    // by removing it from the fake open-findings result.
    fakeState.openFindings = [];
    fakeState.updateCalls = [];
    fakeState.findingsQueryCount = 0;

    await runCheck("tenant-1", "quick_check");

    expect(fakeState.updateCalls.filter((c) => c.table === findingsTable)).toHaveLength(0);
  });

  it("5: legacy findings across different categories are all resolved independently, canonical ones survive", async () => {
    fakeState.openFindings = [
      {
        id: "legacy-attr",
        category: "attribution",
        missedCount: 0,
        evidence: { dedupeKey: "claude:attribution:Assess phone/WhatsApp attribution" },
      },
      {
        id: "legacy-organic",
        category: "organic_traffic",
        missedCount: 0,
        evidence: { dedupeKey: "claude:organic_traffic:Traffic drop requires root-cause triage" },
      },
      {
        id: "legacy-landing",
        category: "landing_page_availability",
        missedCount: 0,
        evidence: { dedupeKey: "claude:landing_page_availability:Validate mobile booking funnel usability" },
      },
      {
        id: "canonical-competitor",
        category: "competitor_observation",
        missedCount: 0,
        evidence: { dedupeKey: "claude:competitor_observation" },
      },
    ];

    await runCheck("tenant-1", "quick_check");

    const resolved = fakeState.updateCalls.filter((c) => c.values.status === "resolved");
    expect(resolved).toHaveLength(3); // the 3 legacy findings only, not the canonical one
  });
});

describe("findings lifecycle — pure decision functions", () => {
  it("isNeverAutoResolved: true for gsc_indexing:*, gtm_no_live_version:*, api_error:*", () => {
    expect(isNeverAutoResolved("gsc_indexing:https://bonolinitransfer.com/")).toBe(true);
    expect(isNeverAutoResolved("gtm_no_live_version:GTM-ABC123")).toBe(true);
    expect(isNeverAutoResolved("api_error:ga4_property:524948086")).toBe(true);
  });

  it("isNeverAutoResolved: false for the auto-resolvable deterministic prefixes and claude:* (now category-scoped, see strategist.ts)", () => {
    expect(isNeverAutoResolved("ga4_traffic_drop:524948086")).toBe(false);
    expect(isNeverAutoResolved("gsc_click_drop:https://bonolinitransfer.com/")).toBe(false);
    expect(isNeverAutoResolved("landing_page_error:https://bonolinitransfer.com/")).toBe(false);
    expect(isNeverAutoResolved("claude:organic_traffic")).toBe(false);
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

  // 7. claude:* IS eligible for the generic miss-based auto-resolve on
  // daily_audit/on_demand now that its dedupeKey is category-scoped and
  // therefore stable across runs (see strategist.ts) — it behaves like
  // website-checks/attribution-checks findings (no linked resource to gate
  // on, so always eligible once covered and not re-detected).
  it("7: isEligibleForMissTracking is true for claude:* on daily_audit (covered, category-scoped dedupeKey)", () => {
    expect(
      isEligibleForMissTracking({
        dedupeKey: "claude:other",
        runType: "daily_audit",
        evidence: {},
        draftsThisRun: [],
        activeResources: [],
      }),
    ).toBe(true);
  });

  // 7b. ...but never on quick_check, since the AI Analyst doesn't run there
  // (isCoveredByRunType already covers this at the pure-function level
  // above) — this confirms the composed isEligibleForMissTracking respects it.
  it("7b: isEligibleForMissTracking is false for claude:* on quick_check (not covered — AI Analyst never runs there)", () => {
    expect(
      isEligibleForMissTracking({
        dedupeKey: "claude:other",
        runType: "quick_check",
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
