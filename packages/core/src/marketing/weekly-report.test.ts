import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Finding } from "@bos/db";

// bucketFindingsForWeeklyReport / synthesizeWeeklyNarrative are pure (or
// near-pure, with Anthropic mocked at the module boundary) — most of the
// coverage below never touches @bos/db, matching the project's convention
// of testing decision logic directly instead of through a full DB mock
// (see ga4-checks.ts's severityForBaseline / run-check.ts's
// isEligibleForMissTracking for the same pattern).

const messagesCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: (...args: unknown[]) => messagesCreate(...args) };
  },
}));

const { bucketFindingsForWeeklyReport, synthesizeWeeklyNarrative } = await import("./weekly-report");

function finding(overrides: {
  status: Finding["status"];
  firstDetectedAt: string;
  resolvedAt?: string | null;
  updatedAt: string;
  category?: Finding["category"];
  severity?: Finding["severity"];
  title?: string;
  businessImpact?: string;
}) {
  return {
    status: overrides.status,
    category: overrides.category ?? "organic_traffic",
    severity: overrides.severity ?? "medium",
    title: overrides.title ?? "Test finding",
    businessImpact: overrides.businessImpact ?? "Some business impact.",
    firstDetectedAt: new Date(overrides.firstDetectedAt),
    resolvedAt: overrides.resolvedAt !== undefined ? (overrides.resolvedAt ? new Date(overrides.resolvedAt) : null) : null,
    updatedAt: new Date(overrides.updatedAt),
  };
}

const PERIOD_START = new Date("2026-08-10T07:00:00Z");

describe("bucketFindingsForWeeklyReport", () => {
  // 1. a finding RESOLVED before periodStart must not be active
  it("1: a finding resolved before periodStart is excluded from activeIssues", () => {
    const f = finding({
      status: "resolved",
      firstDetectedAt: "2026-08-01T10:00:00Z",
      resolvedAt: "2026-08-02T10:00:00Z",
      updatedAt: "2026-08-02T10:00:00Z",
      title: "Old resolved issue",
    });

    const buckets = bucketFindingsForWeeklyReport([f], PERIOD_START);

    expect(buckets.activeIssues).toHaveLength(0);
    expect(buckets.activeIssues.find((x) => x.title === "Old resolved issue")).toBeUndefined();
  });

  // 2. an OPEN finding detected before the week must be active
  it("2: an open finding first detected before the reporting window is still in activeIssues", () => {
    const f = finding({
      status: "open",
      firstDetectedAt: "2026-08-01T10:00:00Z",
      updatedAt: "2026-08-16T10:00:00Z",
      title: "Long-running open issue",
    });

    const buckets = bucketFindingsForWeeklyReport([f], PERIOD_START);

    expect(buckets.activeIssues.map((x) => x.title)).toContain("Long-running open issue");
    expect(buckets.newThisWeek.map((x) => x.title)).not.toContain("Long-running open issue");
  });

  // 3. an OPEN finding detected during the week must be active AND may be new
  it("3: an open finding first detected this week is in both activeIssues and newThisWeek", () => {
    const f = finding({
      status: "open",
      firstDetectedAt: "2026-08-14T10:00:00Z",
      updatedAt: "2026-08-14T10:00:00Z",
      title: "Fresh open issue",
    });

    const buckets = bucketFindingsForWeeklyReport([f], PERIOD_START);

    expect(buckets.activeIssues.map((x) => x.title)).toContain("Fresh open issue");
    expect(buckets.newThisWeek.map((x) => x.title)).toContain("Fresh open issue");
  });

  // 4. a finding RESOLVED during the week is in resolvedThisWeek, not active
  it("4: a finding resolved during the week is in resolvedThisWeek and not in activeIssues", () => {
    const f = finding({
      status: "resolved",
      firstDetectedAt: "2026-08-13T12:00:00Z",
      resolvedAt: "2026-08-13T17:00:00Z",
      updatedAt: "2026-08-13T17:00:00Z",
      title: "Fixed same week",
    });

    const buckets = bucketFindingsForWeeklyReport([f], PERIOD_START);

    expect(buckets.resolvedThisWeek.map((x) => x.title)).toContain("Fixed same week");
    expect(buckets.activeIssues).toHaveLength(0);
  });

  // 5. a finding DISMISSED during the week is in dismissedThisWeek, not active
  it("5: a finding dismissed during the week is in dismissedThisWeek and not in activeIssues", () => {
    const f = finding({
      status: "dismissed",
      firstDetectedAt: "2026-08-13T12:00:00Z",
      updatedAt: "2026-08-13T17:00:00Z",
      title: "Dismissed same week",
    });

    const buckets = bucketFindingsForWeeklyReport([f], PERIOD_START);

    expect(buckets.dismissedThisWeek.map((x) => x.title)).toContain("Dismissed same week");
    expect(buckets.activeIssues).toHaveLength(0);
  });

  // 8. regression — the real 17/08 report case, as fixtures (not live data)
  it("8: regression — 4 resolved landing-page + 3 resolved/dismissed Google Ads findings stay out of activeIssues; the still-open GA4 finding is the only active issue", () => {
    const resolvedLandingPages = [
      finding({
        status: "resolved",
        firstDetectedAt: "2026-08-13T12:33:12Z",
        resolvedAt: "2026-08-13T13:25:08Z",
        updatedAt: "2026-08-13T13:25:08Z",
        category: "landing_page_availability",
        severity: "critical",
        title: "Landing page unreachable",
      }),
      finding({
        status: "resolved",
        firstDetectedAt: "2026-08-13T12:33:12Z",
        resolvedAt: "2026-08-13T13:25:08Z",
        updatedAt: "2026-08-13T13:25:08Z",
        category: "landing_page_availability",
        severity: "critical",
        title: "Landing page unreachable",
      }),
      finding({
        status: "resolved",
        firstDetectedAt: "2026-08-13T13:01:57Z",
        resolvedAt: "2026-08-13T17:29:08Z",
        updatedAt: "2026-08-13T17:29:08Z",
        category: "landing_page_availability",
        severity: "critical",
        title: "Landing page unreachable",
      }),
      finding({
        status: "resolved",
        firstDetectedAt: "2026-08-13T13:01:58Z",
        resolvedAt: "2026-08-13T17:29:07Z",
        updatedAt: "2026-08-13T17:29:07Z",
        category: "landing_page_availability",
        severity: "critical",
        title: "Landing page unreachable",
      }),
    ];

    const googleAdsApiErrors = [
      finding({
        status: "resolved",
        firstDetectedAt: "2026-08-13T12:33:12Z",
        resolvedAt: "2026-08-13T12:55:05Z",
        updatedAt: "2026-08-13T12:55:05Z",
        category: "account_health",
        severity: "medium",
        title: "Could not check google ads account",
      }),
      finding({
        status: "dismissed",
        firstDetectedAt: "2026-08-13T13:01:57Z",
        resolvedAt: null,
        updatedAt: "2026-08-13T13:14:40Z",
        category: "account_health",
        severity: "medium",
        title: "Could not check google ads account",
      }),
      finding({
        status: "resolved",
        firstDetectedAt: "2026-08-13T13:28:06Z",
        resolvedAt: "2026-08-13T17:36:35Z",
        updatedAt: "2026-08-13T17:36:35Z",
        category: "account_health",
        severity: "medium",
        title: "Could not check google ads account",
      }),
    ];

    const ga4TrafficDrop = finding({
      status: "open",
      firstDetectedAt: "2026-08-14T11:07:53Z",
      updatedAt: "2026-08-17T06:01:43Z",
      category: "organic_traffic",
      severity: "medium",
      title: "Significant traffic drop",
    });

    const buckets = bucketFindingsForWeeklyReport(
      [...resolvedLandingPages, ...googleAdsApiErrors, ga4TrafficDrop],
      PERIOD_START,
    );

    expect(buckets.activeIssues).toHaveLength(1);
    expect(buckets.activeIssues[0]!.title).toBe("Significant traffic drop");
    expect(buckets.activeIssues.some((f) => f.category === "landing_page_availability")).toBe(false);
    expect(buckets.activeIssues.some((f) => f.title === "Could not check google ads account")).toBe(false);

    expect(buckets.resolvedThisWeek).toHaveLength(6); // 4 landing pages + 2 resolved google ads
    expect(buckets.dismissedThisWeek).toHaveLength(1); // 1 dismissed google ads
  });
});

describe("synthesizeWeeklyNarrative — Claude path", () => {
  beforeEach(() => {
    messagesCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  // 6. the prompt sent to Claude carries the four labeled sections
  it("6: the content sent to Claude contains all four labeled sections with the right findings", async () => {
    messagesCreate.mockResolvedValue({ content: [{ type: "text", text: "Weekly report body" }] });

    const buckets = {
      activeIssues: [{ category: "organic_traffic", severity: "medium", title: "Active GA4 drop", businessImpact: "x" }],
      resolvedThisWeek: [{ category: "landing_page_availability", severity: "critical", title: "Old outage", businessImpact: "x" }],
      dismissedThisWeek: [{ category: "account_health", severity: "medium", title: "Dismissed ads error", businessImpact: "x" }],
      newThisWeek: [{ category: "organic_traffic", severity: "medium", title: "Active GA4 drop", businessImpact: "x" }],
    };

    await synthesizeWeeklyNarrative(buckets, [93, 94]);

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const sentContent = messagesCreate.mock.calls[0]![0].messages[0].content as string;

    expect(sentContent).toContain("ACTIVE ISSUES:");
    expect(sentContent).toContain("RESOLVED THIS WEEK:");
    expect(sentContent).toContain("DISMISSED THIS WEEK:");
    expect(sentContent).toContain("NEW THIS WEEK:");
    expect(sentContent).toContain("Active GA4 drop");
    expect(sentContent).toContain("Old outage");
    expect(sentContent).toContain("Dismissed ads error");
    expect(sentContent).toContain("Never describe a RESOLVED or DISMISSED finding as an ongoing problem");
  });
});

describe("synthesizeWeeklyNarrative — fallback without ANTHROPIC_API_KEY", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    messagesCreate.mockReset();
  });

  // 7. the fallback never presents a resolved/dismissed finding as active
  it("7: the fallback text separates active from resolved/dismissed/new under distinct headings", async () => {
    const buckets = {
      activeIssues: [{ category: "organic_traffic", severity: "medium", title: "Active GA4 drop", businessImpact: "x" }],
      resolvedThisWeek: [{ category: "landing_page_availability", severity: "critical", title: "Old outage", businessImpact: "x" }],
      dismissedThisWeek: [{ category: "account_health", severity: "medium", title: "Dismissed ads error", businessImpact: "x" }],
      newThisWeek: [],
    };

    const text = await synthesizeWeeklyNarrative(buckets, [93]);

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(text).toContain("ACTIVE ISSUES (current risk)");
    expect(text).toContain("RESOLVED THIS WEEK (historical");
    expect(text).toContain("DISMISSED THIS WEEK (historical");

    const activeSection = text.split("RESOLVED THIS WEEK")[0]!;
    expect(activeSection).toContain("Active GA4 drop");
    expect(activeSection).not.toContain("Old outage");
    expect(activeSection).not.toContain("Dismissed ads error");
  });
});
