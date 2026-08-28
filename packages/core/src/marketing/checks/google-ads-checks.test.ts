import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GoogleAdsCampaignComparisonRow, GoogleAdsSearchTermRow } from "../google-clients";

const fetchGoogleAdsWeeklyPerformance = vi.fn();
const fetchGoogleAdsCampaignComparison = vi.fn();
const fetchGoogleAdsSearchTerms = vi.fn();

vi.mock("../google-clients", () => ({
  fetchGoogleAdsWeeklyPerformance: (...args: unknown[]) => fetchGoogleAdsWeeklyPerformance(...args),
  fetchGoogleAdsCampaignComparison: (...args: unknown[]) => fetchGoogleAdsCampaignComparison(...args),
  fetchGoogleAdsSearchTerms: (...args: unknown[]) => fetchGoogleAdsSearchTerms(...args),
}));

const { runChecks, runCampaignChecks, runSearchTermChecks, classifySearchTerm } = await import("./google-ads-checks");

function performance(totals: Partial<Record<string, number>>) {
  return {
    customerId: "123-456-7890",
    dateRange: "2026-08-01..2026-08-08",
    totals: {
      impressions: 0,
      clicks: 0,
      costCents: 0,
      conversions: 0,
      conversionValue: 0,
      averageCpc: 0,
      ctr: 0,
      ...totals,
    },
    rows: [],
  };
}

describe("google-ads-checks", () => {
  beforeEach(() => {
    fetchGoogleAdsWeeklyPerformance.mockReset();
    fetchGoogleAdsCampaignComparison.mockReset();
    fetchGoogleAdsCampaignComparison.mockResolvedValue([]);
    fetchGoogleAdsSearchTerms.mockReset();
    fetchGoogleAdsSearchTerms.mockResolvedValue([]);
  });

  it("flags zero conversions with meaningful spend as a critical account_health finding", async () => {
    fetchGoogleAdsWeeklyPerformance.mockResolvedValue(
      performance({ costCents: 10000, conversions: 0, impressions: 500, ctr: 0.05 }),
    );

    const drafts = await runChecks("tenant-1", "123-456-7890");

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      category: "account_health",
      nature: "technical_issue",
      severity: "critical",
      dedupeKey: "google_ads:zero_conversions:123-456-7890",
    });
  });

  it("flags high cost per conversion as a budget_waste finding", async () => {
    fetchGoogleAdsWeeklyPerformance.mockResolvedValue(
      performance({ costCents: 20000, conversions: 1, impressions: 500, ctr: 0.05 }),
    );

    const drafts = await runChecks("tenant-1", "123-456-7890");

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      category: "budget_waste",
      nature: "technical_issue",
      severity: "high",
      dedupeKey: "google_ads:high_cost_per_conversion:123-456-7890",
    });
  });

  it("flags low CTR as a quality_score finding", async () => {
    fetchGoogleAdsWeeklyPerformance.mockResolvedValue(
      performance({ costCents: 1000, conversions: 1, impressions: 1000, ctr: 0.005 }),
    );

    const drafts = await runChecks("tenant-1", "123-456-7890");

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      category: "quality_score",
      nature: "technical_issue",
      severity: "medium",
      dedupeKey: "google_ads:low_ctr:123-456-7890",
    });
  });

  it("produces no findings for healthy metrics", async () => {
    fetchGoogleAdsWeeklyPerformance.mockResolvedValue(
      performance({ costCents: 5000, conversions: 10, impressions: 1000, ctr: 0.05 }),
    );

    const drafts = await runChecks("tenant-1", "123-456-7890");

    expect(drafts).toHaveLength(0);
  });

  it("does not flag low spend below the cost-per-conversion threshold", async () => {
    fetchGoogleAdsWeeklyPerformance.mockResolvedValue(
      performance({ costCents: 100, conversions: 0, impressions: 10, ctr: 0 }),
    );

    const drafts = await runChecks("tenant-1", "123-456-7890");

    expect(drafts).toHaveLength(0);
  });

  // Regression: this check has no try/catch of its own around
  // fetchGoogleAdsWeeklyPerformance — that's deliberate. An API error must
  // propagate up to run-check.ts's per-resource catch, which turns it into
  // an api_error finding. Swallowing it here (e.g. returning [] or a
  // zero-performance draft) would silently hide a broken Google Ads
  // connection instead of surfacing it — see the 13/08 INVALID_CUSTOMER_ID /
  // PAGE_SIZE_NOT_SUPPORTED / UNRECOGNIZED_FIELD incidents this guards against.
  it("propagates a Google Ads API error instead of swallowing it into an empty or zero-performance result", async () => {
    fetchGoogleAdsWeeklyPerformance.mockRejectedValue(
      new Error(
        'Google Ads query failed (400): {"error":{"code":400,"message":"Request contains an invalid argument."}}',
      ),
    );

    await expect(runChecks("tenant-1", "678-018-7978")).rejects.toThrow("Google Ads query failed (400)");
  });

  it("propagates a campaign-comparison fetch error the same way as an account-level one", async () => {
    fetchGoogleAdsWeeklyPerformance.mockResolvedValue(performance({}));
    fetchGoogleAdsCampaignComparison.mockRejectedValue(new Error("Google Ads query failed (400): campaign report"));

    await expect(runChecks("tenant-1", "678-018-7978")).rejects.toThrow("Google Ads query failed (400)");
  });

  it("merges campaign-level findings from runCampaignChecks into the account-level drafts", async () => {
    fetchGoogleAdsWeeklyPerformance.mockResolvedValue(performance({}));
    fetchGoogleAdsCampaignComparison.mockResolvedValue([
      campaignRow({ recentCostCents: 6000, recentConversions: 0, recentClicks: 10 }),
    ]);

    const drafts = await runChecks("tenant-1", "678-018-7978");

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ dedupeKey: "google_ads_campaign_spend_no_conversion:111" });
  });

  it("propagates a search-term fetch error the same way as an account/campaign-level one", async () => {
    fetchGoogleAdsWeeklyPerformance.mockResolvedValue(performance({}));
    fetchGoogleAdsSearchTerms.mockRejectedValue(new Error("Google Ads query failed (400): search term report"));

    await expect(runChecks("tenant-1", "678-018-7978")).rejects.toThrow("Google Ads query failed (400)");
  });

  it("merges search-term findings from runSearchTermChecks into the account-level drafts", async () => {
    fetchGoogleAdsWeeklyPerformance.mockResolvedValue(performance({}));
    fetchGoogleAdsSearchTerms.mockResolvedValue([searchTermRow({ clicks: 5, conversions: 0, costCents: 900 })]);

    const drafts = await runChecks("tenant-1", "678-018-7978");

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ dedupeKey: "google_ads_search_term:222:test query" });
  });
});

function campaignRow(overrides: Partial<GoogleAdsCampaignComparisonRow> = {}): GoogleAdsCampaignComparisonRow {
  return {
    campaignId: "111",
    campaignName: "Test Campaign",
    campaignStatus: "ENABLED",
    budgetMicros: 10000000,
    recentCostCents: 0,
    recentConversions: 0,
    recentConversionValue: 0,
    recentClicks: 0,
    recentImpressions: 0,
    recentAverageCpc: 0,
    previousCostCents: 0,
    previousConversions: 0,
    previousClicks: 0,
    previousImpressions: 0,
    previousAverageCpc: 0,
    ...overrides,
  };
}

describe("runCampaignChecks", () => {
  it("1: flags spend without conversions at the same €50 threshold as the account-level check", () => {
    const drafts = runCampaignChecks("678-018-7978", [
      campaignRow({ recentCostCents: 5000, recentConversions: 0, recentClicks: 8 }),
    ]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      dedupeKey: "google_ads_campaign_spend_no_conversion:111",
      category: "account_health",
      severity: "critical",
    });
  });

  it("does not flag spend-without-conversions below the €50 threshold", () => {
    const drafts = runCampaignChecks("678-018-7978", [
      campaignRow({ recentCostCents: 4999, recentConversions: 0, recentClicks: 3 }),
    ]);

    expect(drafts).toHaveLength(0);
  });

  it("2: flags a spend spike (>=50% increase) with severity high", () => {
    const drafts = runCampaignChecks("678-018-7978", [
      campaignRow({ recentCostCents: 12000, previousCostCents: 6000, recentConversions: 1, previousConversions: 1 }),
    ]);

    const spend = drafts.find((d) => d.dedupeKey === "google_ads_campaign_spend_anomaly:111");
    expect(spend).toMatchObject({ category: "budget_pacing", severity: "high" });
  });

  it("2b: flags a spend drop (>=50% decrease) with severity medium", () => {
    const drafts = runCampaignChecks("678-018-7978", [
      campaignRow({ recentCostCents: 2000, previousCostCents: 6000, recentConversions: 1, previousConversions: 1 }),
    ]);

    const spend = drafts.find((d) => d.dedupeKey === "google_ads_campaign_spend_anomaly:111");
    expect(spend).toMatchObject({ category: "budget_pacing", severity: "medium" });
  });

  it("does not flag a spend anomaly when the previous period is below the €50 baseline (avoids noise on tiny numbers)", () => {
    const drafts = runCampaignChecks("678-018-7978", [
      campaignRow({ recentCostCents: 1000, previousCostCents: 100 }), // 900% change, but previous period too small to trust
    ]);

    expect(drafts.find((d) => d.dedupeKey === "google_ads_campaign_spend_anomaly:111")).toBeUndefined();
  });

  it("3: flags a CPC anomaly only when both periods actually had clicks", () => {
    const drafts = runCampaignChecks("678-018-7978", [
      campaignRow({ recentClicks: 5, previousClicks: 5, recentAverageCpc: 3, previousAverageCpc: 1.5 }),
    ]);

    expect(drafts.find((d) => d.dedupeKey === "google_ads_campaign_cpc_anomaly:111")).toMatchObject({
      category: "bid_cpc_anomaly",
    });
  });

  it("does not flag a CPC anomaly when the recent period had zero clicks (no real CPC to compare)", () => {
    const drafts = runCampaignChecks("678-018-7978", [
      campaignRow({ recentClicks: 0, previousClicks: 5, recentAverageCpc: 0, previousAverageCpc: 1.5 }),
    ]);

    expect(drafts.find((d) => d.dedupeKey === "google_ads_campaign_cpc_anomaly:111")).toBeUndefined();
  });

  it("4: flags a conversion drop when the previous period had a real baseline", () => {
    const drafts = runCampaignChecks("678-018-7978", [
      campaignRow({ recentConversions: 1, previousConversions: 4 }), // -75%
    ]);

    expect(drafts.find((d) => d.dedupeKey === "google_ads_campaign_conversion_drop:111")).toMatchObject({
      category: "account_health",
      severity: "high",
    });
  });

  it("does not flag a conversion drop when the previous period's conversion count is too small to be a real baseline", () => {
    const drafts = runCampaignChecks("678-018-7978", [
      campaignRow({ recentConversions: 0, previousConversions: 1 }), // 100% drop, but baseline is just 1
    ]);

    expect(drafts.find((d) => d.dedupeKey === "google_ads_campaign_conversion_drop:111")).toBeUndefined();
  });

  it("5: flags a CPA anomaly when both periods have a real conversion baseline and cost per conversion rose", () => {
    const drafts = runCampaignChecks("678-018-7978", [
      campaignRow({ recentCostCents: 9000, recentConversions: 3, previousCostCents: 4000, previousConversions: 4 }),
      // recentCpa = 3000c/conv, previousCpa = 1000c/conv -> +200%
    ]);

    expect(drafts.find((d) => d.dedupeKey === "google_ads_campaign_cpa_anomaly:111")).toMatchObject({
      category: "budget_waste",
    });
  });

  it("a collapsed campaign (few recent conversions) triggers conversion_drop, not a double-counted CPA anomaly", () => {
    const drafts = runCampaignChecks("678-018-7978", [
      campaignRow({ recentCostCents: 3000, recentConversions: 1, previousCostCents: 4000, previousConversions: 4 }),
    ]);

    expect(drafts.find((d) => d.dedupeKey === "google_ads_campaign_conversion_drop:111")).toBeDefined();
    expect(drafts.find((d) => d.dedupeKey === "google_ads_campaign_cpa_anomaly:111")).toBeUndefined();
  });

  it("produces no findings for a healthy campaign with no significant week-over-week change", () => {
    const drafts = runCampaignChecks("678-018-7978", [
      campaignRow({
        recentCostCents: 6000,
        previousCostCents: 6200,
        recentConversions: 5,
        previousConversions: 5,
        recentClicks: 20,
        previousClicks: 20,
        recentAverageCpc: 3,
        previousAverageCpc: 3.1,
      }),
    ]);

    expect(drafts).toHaveLength(0);
  });
});

function searchTermRow(overrides: Partial<GoogleAdsSearchTermRow> = {}): GoogleAdsSearchTermRow {
  return {
    campaignId: "222",
    campaignName: "Test Search Campaign",
    searchTerm: "test query",
    normalizedSearchTerm: "test query",
    status: "NONE",
    costCents: 0,
    clicks: 0,
    impressions: 0,
    conversions: 0,
    conversionValue: 0,
    ctr: 0,
    averageCpc: 0,
    ...overrides,
  };
}

describe("classifySearchTerm", () => {
  it("classifies as performance_problem when it converts but cost per conversion is at/above the €150 account-level threshold", () => {
    const result = classifySearchTerm(searchTermRow({ costCents: 15000, conversions: 1 }));

    expect(result).toEqual({ decision: "performance_problem", costPerConversionCents: 15000 });
  });

  it("classifies as positive_keyword_opportunity when it has at least one real conversion and isn't already an added keyword", () => {
    const result = classifySearchTerm(searchTermRow({ costCents: 3000, conversions: 1, status: "NONE" }));

    expect(result.decision).toBe("positive_keyword_opportunity");
  });

  it("does not classify as an opportunity when conversions are fractional and below 1 (partial/assisted attribution)", () => {
    const result = classifySearchTerm(searchTermRow({ costCents: 1000, conversions: 0.83, clicks: 1 }));

    expect(result.decision).toBe("keep_monitor");
  });

  it("does not classify as an opportunity when the term is already an added keyword (already realized, nothing to create)", () => {
    const result = classifySearchTerm(searchTermRow({ costCents: 3000, conversions: 1, status: "ADDED" }));

    expect(result.decision).toBe("keep_monitor");
  });

  it("classifies as negative_keyword_review when it has real clicks/cost, zero conversions, and isn't already added", () => {
    const result = classifySearchTerm(searchTermRow({ costCents: 900, clicks: 3, conversions: 0, status: "NONE" }));

    expect(result.decision).toBe("negative_keyword_review");
  });

  it("does not classify as negative_keyword_review below the click threshold (avoids noise on a single stray click)", () => {
    const result = classifySearchTerm(searchTermRow({ costCents: 200, clicks: 2, conversions: 0, status: "NONE" }));

    expect(result.decision).toBe("keep_monitor");
  });

  it("does not classify an already-added keyword's zero-conversion term as negative_keyword_review", () => {
    const result = classifySearchTerm(searchTermRow({ costCents: 900, clicks: 5, conversions: 0, status: "ADDED" }));

    expect(result.decision).toBe("keep_monitor");
  });

  it("performance_problem takes priority over positive_keyword_opportunity when both conditions technically overlap", () => {
    const result = classifySearchTerm(searchTermRow({ costCents: 20000, conversions: 1, status: "NONE" }));

    expect(result.decision).toBe("performance_problem");
  });
});

describe("runSearchTermChecks", () => {
  it("emits a budget_waste finding for a performance_problem search term with the stable campaign+term dedupeKey", () => {
    const drafts = runSearchTermChecks("678-018-7978", [
      searchTermRow({ campaignId: "333", searchTerm: "bernina express milan", normalizedSearchTerm: "bernina express milan", costCents: 18000, conversions: 1 }),
    ]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      dedupeKey: "google_ads_search_term:333:bernina express milan",
      category: "budget_waste",
      severity: "high",
      nature: "technical_issue",
    });
  });

  it("emits an impression_share strategic_opportunity finding for a positive_keyword_opportunity search term", () => {
    const drafts = runSearchTermChecks("678-018-7978", [
      searchTermRow({ costCents: 2500, conversions: 1, status: "NONE" }),
    ]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      category: "impression_share",
      nature: "strategic_opportunity",
      severity: "low",
    });
  });

  it("emits a requiresApproval budget_waste review finding for a negative_keyword_review search term, never asserting irrelevance", () => {
    const drafts = runSearchTermChecks("678-018-7978", [
      searchTermRow({ clicks: 4, costCents: 1200, conversions: 0, status: "NONE" }),
    ]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ category: "budget_waste", severity: "medium", requiresApproval: true });
    expect(drafts[0]?.title).toMatch(/review/i);
    expect(drafts[0]?.title).not.toMatch(/^Negative keyword/i);
  });

  it("emits no finding for a keep_monitor search term (insufficient data — the same 'healthy, no finding' convention as every other check)", () => {
    const drafts = runSearchTermChecks("678-018-7978", [searchTermRow({ clicks: 1, costCents: 200, conversions: 0 })]);

    expect(drafts).toHaveLength(0);
  });

  it("skips an EXCLUDED search term entirely, even with heavy zero-conversion spend (already resolved in Google Ads)", () => {
    const drafts = runSearchTermChecks("678-018-7978", [
      searchTermRow({ clicks: 20, costCents: 5000, conversions: 0, status: "EXCLUDED" }),
    ]);

    expect(drafts).toHaveLength(0);
  });

  it("includes the full QUERY/CAMPAGNA/COSTO/CLIC/IMPRESSION/CTR/CPC/CONVERSIONI/COST-PER-CONVERSIONE evidence the founder asked for", () => {
    const drafts = runSearchTermChecks("678-018-7978", [
      searchTermRow({
        campaignId: "444",
        campaignName: "Malpensa Core",
        searchTerm: "taxi sondrio aeroporto",
        clicks: 6,
        impressions: 40,
        costCents: 1500,
        conversions: 0,
        ctr: 0.15,
        averageCpc: 2.5,
        status: "NONE",
      }),
    ]);

    expect(drafts[0]?.evidence).toMatchObject({
      campaignId: "444",
      campaignName: "Malpensa Core",
      searchTerm: "taxi sondrio aeroporto",
      clicks: 6,
      impressions: 40,
      costCents: 1500,
      conversions: 0,
      ctr: 0.15,
      averageCpc: 2.5,
      costPerConversionCents: null,
    });
  });
});
