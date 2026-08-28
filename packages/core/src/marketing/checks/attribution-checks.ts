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

  const drafts: FindingDraft[] = [];

  if (ratio >= UNTAGGED_RATIO_THRESHOLD) {
    drafts.push({
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
    });
  }

  // A structurally different failure from the one above: that check only
  // sees leads that DO have a gclid but are missing utm — it can never fire
  // when gclid itself is never captured, which is exactly the real
  // Production state found 2026-08-28 (0 of 28 recent leads had a gclid,
  // utm_source, or landing_page at all). Reuses UNTAGGED_RATIO_THRESHOLD's
  // exact value — same "how much is tolerable before it's a real problem"
  // judgment, applied to a qualitatively different condition.
  const fullyUnattributed = recentLeads.filter((c) => !c.gclid && !c.utmSource && !c.landingPage);
  const fullyUnattributedRatio = fullyUnattributed.length / recentLeads.length;

  if (fullyUnattributedRatio >= UNTAGGED_RATIO_THRESHOLD) {
    drafts.push({
      dedupeKey: `attribution_capture_failure:${tenantId}`,
      category: "attribution",
      nature: "technical_issue",
      severity: "high",
      confidenceScore: 65,
      title: "Most recent leads carry no marketing attribution data at all",
      observation: `${fullyUnattributed.length} of the last ${recentLeads.length} leads (${Math.round(fullyUnattributedRatio * 100)}%) have no Google Ads click ID, no UTM source, and no recorded landing page.`,
      rootCause:
        "The request-quote form isn't capturing or forwarding gclid/UTM parameters/landing page URL from the real visit — likely the relevant hidden fields aren't being populated client-side, or aren't reaching the server action unchanged on submission.",
      businessImpact:
        "Without this data, it isn't possible to tell which of these leads (if any) came from Google Ads — cost-per-lead and campaign-level lead attribution can't be computed for them.",
      financialImpact: null,
      recommendedActions: [
        "Check whether the request-quote form's hidden gclid/utm/landingPage fields are actually populated in a real browser session, not just in local testing",
        "Verify those values reach the submitLead server action unchanged",
      ],
      requiresApproval: false,
      expectedBenefit: "Restores the ability to compute Google-Ads-attributable leads and cost-per-lead.",
      evidence: {
        tenantId,
        fullyUnattributedCount: fullyUnattributed.length,
        totalLeads: recentLeads.length,
        ratio: fullyUnattributedRatio,
      },
    });
  }

  return drafts;
}
