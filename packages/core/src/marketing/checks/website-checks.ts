import type { FindingDraft } from "../rule-types";

// No Google API involved — plain HTTP checks against transfer-web's own
// key pages. URLs come from MARKETING_MONITORED_URLS (comma-separated) —
// there's no UI to manage this list yet, just an env var.
function getMonitoredUrls(): string[] {
  const raw = process.env.MARKETING_MONITORED_URLS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

const SLOW_RESPONSE_MS = 3000;

export async function runChecks(): Promise<FindingDraft[]> {
  const urls = getMonitoredUrls();
  const drafts: FindingDraft[] = [];

  for (const url of urls) {
    const start = Date.now();
    try {
      const response = await fetch(url, { method: "GET", redirect: "follow" });
      const elapsedMs = Date.now() - start;

      if (!response.ok) {
        drafts.push({
          dedupeKey: `landing_page_error:${url}`,
          category: "landing_page_availability",
          nature: "technical_issue",
          severity: "critical",
          confidenceScore: 95,
          title: `Landing page returning HTTP ${response.status}`,
          observation: `${url} returned HTTP ${response.status}.`,
          rootCause:
            "The page is erroring or unreachable — a deploy issue, expired domain/certificate, or server outage are the most likely causes.",
          businessImpact:
            "Any ad traffic sent to this URL is being wasted — visitors can't see the page at all.",
          financialImpact: {
            amount: null,
            currency: "EUR",
            period: "daily",
            direction: "cost",
            note: "Wasted ad spend on this URL's traffic until fixed.",
          },
          recommendedActions: [
            "Check hosting/deploy status for this URL",
            "Verify DNS and SSL certificate are valid",
            "Pause any ads pointing at this URL until it's confirmed working",
          ],
          requiresApproval: false,
          expectedBenefit: "Ad clicks convert instead of hitting an error page.",
          evidence: { url, status: response.status, elapsedMs },
        });
      } else if (elapsedMs > SLOW_RESPONSE_MS) {
        drafts.push({
          dedupeKey: `landing_page_slow:${url}`,
          category: "page_speed",
          nature: "technical_issue",
          severity: "medium",
          confidenceScore: 80,
          title: "Slow landing page response",
          observation: `${url} took ${elapsedMs}ms to respond (threshold: ${SLOW_RESPONSE_MS}ms).`,
          rootCause: "Server/hosting performance issue, or an unoptimized page.",
          businessImpact:
            "Slow pages increase bounce rate and reduce conversion rate for paid traffic, and hurt Google Ads Quality Score.",
          financialImpact: null,
          recommendedActions: [
            "Investigate server response time",
            "Check for unoptimized assets or slow queries on this page",
          ],
          requiresApproval: false,
          expectedBenefit: "Faster page loads typically improve conversion rate and Quality Score.",
          evidence: { url, elapsedMs },
        });
      }
    } catch (error) {
      drafts.push({
        dedupeKey: `landing_page_unreachable:${url}`,
        category: "landing_page_availability",
        nature: "technical_issue",
        severity: "critical",
        confidenceScore: 90,
        title: "Landing page unreachable",
        observation: `${url} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        rootCause: "DNS failure, network issue, or the server is completely down.",
        businessImpact: "Any ad traffic sent to this URL is being wasted.",
        financialImpact: { amount: null, currency: "EUR", period: "daily", direction: "cost" },
        recommendedActions: ["Check hosting status immediately", "Verify DNS records"],
        requiresApproval: false,
        expectedBenefit: "Ad clicks convert instead of failing outright.",
        evidence: { url, error: String(error) },
      });
    }
  }

  return drafts;
}
