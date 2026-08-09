import { and, eq, gte } from "drizzle-orm";
import { getDb, clients } from "@bos/db";
import type { FindingDraft } from "../rule-types";

// Uses only BOS's own data (clients' first-touch attribution fields) — no
// Google API call, so this is the most reliable check in the catalog.
// Checks BOS's side of attribution health, not GA4-vs-Ads reconciliation
// (that needs the Google Ads API — not integrated yet).

const MIN_LEADS_FOR_CHECK = 10;
const UNTAGGED_RATIO_THRESHOLD = 0.3;

export async function runChecks(tenantId: string): Promise<FindingDraft[]> {
  const db = getDb();
  const since = new Date();
  since.setDate(since.getDate() - 14);

  const recentLeads = await db
    .select()
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), gte(clients.createdAt, since)));

  if (recentLeads.length < MIN_LEADS_FOR_CHECK) return [];

  const untaggedWithGclid = recentLeads.filter((c) => c.gclid && !c.utmCampaign && !c.utmSource);
  const ratio = untaggedWithGclid.length / recentLeads.length;

  if (ratio < UNTAGGED_RATIO_THRESHOLD) return [];

  return [
    {
      dedupeKey: `attribution_untagged_ratio:${tenantId}`,
      category: "attribution",
      nature: "technical_issue",
      severity: "medium",
      confidenceScore: 60,
      title: "Many leads have a Google Ads click ID but no campaign tagging",
      observation: `${untaggedWithGclid.length} of the last ${recentLeads.length} leads (${Math.round(ratio * 100)}%) arrived with a Google Ads click ID (gclid) but no utm_campaign/utm_source.`,
      rootCause:
        "Auto-tagging may be disabled in the Google Ads account, or the tracking template/final URL suffix isn't passing UTM parameters through to the landing page.",
      businessImpact:
        "Without campaign-level tagging, revenue can't be attributed to specific campaigns — the revenue-by-campaign and cost-per-stage reporting in /marketing will be inaccurate for these leads.",
      financialImpact: null,
      recommendedActions: [
        "Verify auto-tagging is enabled in Google Ads account settings",
        "Check the campaign's tracking template / final URL suffix",
      ],
      requiresApproval: false,
      expectedBenefit: "Restores accurate campaign-level attribution for revenue and cost-per-stage reporting.",
      evidence: { untaggedCount: untaggedWithGclid.length, totalLeads: recentLeads.length, ratio },
    },
  ];
}
