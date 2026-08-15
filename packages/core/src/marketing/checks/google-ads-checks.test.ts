import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchGoogleAdsWeeklyPerformance = vi.fn();

vi.mock("../google-clients", () => ({
  fetchGoogleAdsWeeklyPerformance: (...args: unknown[]) => fetchGoogleAdsWeeklyPerformance(...args),
}));

const { runChecks } = await import("./google-ads-checks");

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
});
