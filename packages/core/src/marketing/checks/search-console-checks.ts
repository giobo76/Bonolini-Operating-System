import { getSearchConsoleClient } from "../google-clients";
import type { FindingDraft } from "../rule-types";

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0]!;
}

function getMonitoredUrls(fallback: string): string[] {
  const raw = process.env.MARKETING_MONITORED_URLS;
  if (!raw) return [fallback];
  const urls = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  return urls.length > 0 ? urls : [fallback];
}

export async function runChecks(tenantId: string, siteUrl: string): Promise<FindingDraft[]> {
  const searchconsole = await getSearchConsoleClient(tenantId);
  const drafts: FindingDraft[] = [];

  const [recent, previous] = await Promise.all([
    searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: { startDate: dateNDaysAgo(10), endDate: dateNDaysAgo(3), dimensions: [] },
    }),
    searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: { startDate: dateNDaysAgo(20), endDate: dateNDaysAgo(11), dimensions: [] },
    }),
  ]);

  const recentClicks = recent.data.rows?.[0]?.clicks ?? 0;
  const previousClicks = previous.data.rows?.[0]?.clicks ?? 0;

  if (previousClicks >= 10 && recentClicks <= previousClicks * 0.5) {
    drafts.push({
      dedupeKey: `gsc_click_drop:${siteUrl}`,
      category: "organic_traffic",
      nature: "technical_issue",
      severity: "medium",
      confidenceScore: 65,
      title: "Organic search clicks dropped",
      observation: `Search Console clicks dropped from ${previousClicks} to ${recentClicks} over comparable ~week-long windows.`,
      rootCause: "Could be an indexing issue, a ranking drop, or a seasonal pattern.",
      businessImpact: "Fewer organic visitors means fewer free (non-paid) leads.",
      financialImpact: null,
      recommendedActions: [
        "Check the indexing findings below",
        "Review recent site changes that might affect SEO",
        "Check Search Console's Performance report for the affected queries/pages",
      ],
      requiresApproval: false,
      expectedBenefit: "Restoring organic visibility recovers free lead volume.",
      evidence: { siteUrl, recentClicks, previousClicks },
    });
  }

  // URL Inspection API has tight quotas (2,000/day, 600/min per site) — a
  // failure on one URL shouldn't fail the whole check run.
  for (const url of getMonitoredUrls(siteUrl)) {
    try {
      const inspection = await searchconsole.urlInspection.index.inspect({
        requestBody: { inspectionUrl: url, siteUrl },
      });
      const result = inspection.data.inspectionResult?.indexStatusResult;
      const verdict = result?.verdict;

      if (verdict && verdict !== "PASS") {
        drafts.push({
          dedupeKey: `gsc_indexing:${url}`,
          category: "search_console_indexing",
          nature: "technical_issue",
          severity: "high",
          confidenceScore: 85,
          title: "Page has an indexing problem",
          observation: `${url} indexing verdict: ${verdict}${result?.coverageState ? ` (${result.coverageState})` : ""}.`,
          rootCause: result?.coverageState ?? "See Search Console's URL Inspection tool for detail.",
          businessImpact: "This page may not appear in Google search results, losing organic visibility.",
          financialImpact: null,
          recommendedActions: [
            "Review the page in Search Console's URL Inspection tool",
            "Check for noindex tags, robots.txt blocks, or crawl errors",
          ],
          requiresApproval: false,
          expectedBenefit: "Getting the page indexed restores its organic search visibility.",
          evidence: { url, verdict, coverageState: result?.coverageState },
        });
      }
    } catch {
      // Quota or transient error — skip this URL this run, don't fail the
      // whole check.
      continue;
    }
  }

  return drafts;
}
