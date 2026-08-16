import { describe, expect, it, vi, beforeEach } from "vitest";

const query = vi.fn();
const inspect = vi.fn();

vi.mock("../google-clients", () => ({
  getSearchConsoleClient: async () => ({
    searchanalytics: { query },
    urlInspection: { index: { inspect } },
  }),
}));

const { runChecks } = await import("./search-console-checks");

const SITE_URL = "https://bonolinitransfer.com/";

function clicksResponse(clicks: number) {
  return { data: { rows: clicks > 0 ? [{ clicks }] : [] } };
}

function passingInspection() {
  return { data: { inspectionResult: { indexStatusResult: { verdict: "PASS" } } } };
}

describe("search-console-checks — gsc_click_drop", () => {
  beforeEach(() => {
    query.mockReset();
    inspect.mockReset();
    inspect.mockResolvedValue(passingInspection());
    delete process.env.MARKETING_MONITORED_URLS;
  });

  it("produces no finding when the baseline is below 10 clicks", async () => {
    query.mockResolvedValueOnce(clicksResponse(3)).mockResolvedValueOnce(clicksResponse(9));

    const drafts = await runChecks("tenant-1", SITE_URL);

    expect(drafts.filter((d) => d.dedupeKey === `gsc_click_drop:${SITE_URL}`)).toHaveLength(0);
  });

  it("produces no finding when the drop is below -50%", async () => {
    query.mockResolvedValueOnce(clicksResponse(80)).mockResolvedValueOnce(clicksResponse(100)); // -20%

    const drafts = await runChecks("tenant-1", SITE_URL);

    expect(drafts.filter((d) => d.dedupeKey === `gsc_click_drop:${SITE_URL}`)).toHaveLength(0);
  });

  it("produces a medium-severity finding on a >=50% drop, with daily-average evidence over equal windows", async () => {
    query.mockResolvedValueOnce(clicksResponse(14)).mockResolvedValueOnce(clicksResponse(70)); // -80%

    const drafts = await runChecks("tenant-1", SITE_URL);
    const finding = drafts.find((d) => d.dedupeKey === `gsc_click_drop:${SITE_URL}`);

    expect(finding).toMatchObject({
      category: "organic_traffic",
      severity: "medium",
      confidenceScore: 65,
    });
    expect(finding!.evidence).toMatchObject({
      recentClicks: 14,
      previousClicks: 70,
      recentWindowDays: 7,
      previousWindowDays: 7,
      recentDailyAvg: 2,
      previousDailyAvg: 10,
      changePct: -0.8,
    });
  });

  it("regression: requests recent and previous windows of equal duration, contiguous with the GSC processing lag", async () => {
    query.mockResolvedValueOnce(clicksResponse(14)).mockResolvedValueOnce(clicksResponse(70));

    await runChecks("tenant-1", SITE_URL);

    type QueryCall = { requestBody: { startDate: string; endDate: string } };
    const recentCall = query.mock.calls[0]![0] as QueryCall;
    const previousCall = query.mock.calls[1]![0] as QueryCall;

    function daysBetween(startDate: string, endDate: string): number {
      const days = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
      return days(startDate, endDate) + 1;
    }

    expect(daysBetween(recentCall.requestBody.startDate, recentCall.requestBody.endDate)).toBe(
      daysBetween(previousCall.requestBody.startDate, previousCall.requestBody.endDate),
    );
    // Contiguous: previous window's end is the day right before recent window's start.
    const dayAfter = (d: string) => new Date(new Date(d).getTime() + 86_400_000).toISOString().split("T")[0];
    expect(dayAfter(previousCall.requestBody.endDate)).toBe(recentCall.requestBody.startDate);
  });

  it("still flags a non-PASS indexing verdict independently of the click-drop check", async () => {
    query.mockResolvedValueOnce(clicksResponse(50)).mockResolvedValueOnce(clicksResponse(55));
    inspect.mockResolvedValueOnce({
      data: { inspectionResult: { indexStatusResult: { verdict: "NEUTRAL", coverageState: "Excluded" } } },
    });

    const drafts = await runChecks("tenant-1", SITE_URL);

    expect(drafts).toContainEqual(
      expect.objectContaining({ dedupeKey: `gsc_indexing:${SITE_URL}`, category: "search_console_indexing" }),
    );
  });
});
