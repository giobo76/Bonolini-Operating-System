import { fetchGoogleAdsWeeklyPerformance } from "../google-clients";
import type { FindingDraft } from "../rule-types";

// UNVERIFIED AGAINST A LIVE ACCOUNT: written against the documented Google
// Ads API v25 metric shapes, not yet run against a real customer — same
// caveat as every other checks/*.ts module (see marketing/README.md).
// `metrics.ctr` is assumed to be a 0-1 fraction (Google's documented shape),
// not a percentage — verify against real data the first time this runs.

const MIN_SPEND_FOR_COST_PER_CONVERSION_CENTS = 5000; // €50
const HIGH_COST_PER_CONVERSION_CENTS = 15000; // €150 — same threshold used previously in the (now retired) analytics.ts anomaly rule
const ZERO_CONVERSION_SPEND_THRESHOLD_CENTS = 5000; // €50
const MIN_IMPRESSIONS_FOR_CTR_CHECK = 100;
const LOW_CTR_THRESHOLD = 0.01;

export async function runChecks(tenantId: string, customerId: string): Promise<FindingDraft[]> {
  const drafts: FindingDraft[] = [];
  const performance = await fetchGoogleAdsWeeklyPerformance(tenantId, customerId);
  const { totals, dateRange } = performance;

  if (totals.costCents > ZERO_CONVERSION_SPEND_THRESHOLD_CENTS && totals.conversions === 0) {
    drafts.push({
      dedupeKey: `google_ads:zero_conversions:${customerId}`,
      category: "account_health",
      nature: "technical_issue",
      severity: "critical",
      confidenceScore: 80,
      title: "Google Ads spend with zero recorded conversions",
      observation: `€${(totals.costCents / 100).toFixed(2)} spent over ${dateRange} with 0 conversions recorded.`,
      rootCause:
        "Likely a conversion tracking mismatch between Google Ads and the actual booking funnel, or campaigns targeting the wrong audience.",
      businessImpact: "Ad spend is not producing any measurable leads or bookings.",
      financialImpact: {
        amount: totals.costCents / 100,
        currency: "EUR",
        period: "weekly",
        direction: "cost",
        note: "Spend with no recorded conversions this period.",
      },
      recommendedActions: [
        "Verify Google Ads conversion tracking is correctly configured",
        "Compare against GA4's generate_lead event count for the same period",
        "Review campaign targeting and search terms",
      ],
      requiresApproval: false,
      expectedBenefit: "Restoring conversion tracking or targeting allows spend to convert to real leads.",
      evidence: { customerId, dateRange, costCents: totals.costCents, conversions: totals.conversions },
    });
  } else if (
    totals.costCents > MIN_SPEND_FOR_COST_PER_CONVERSION_CENTS &&
    totals.conversions > 0 &&
    totals.costCents / totals.conversions > HIGH_COST_PER_CONVERSION_CENTS
  ) {
    const costPerConversion = totals.costCents / totals.conversions / 100;
    drafts.push({
      dedupeKey: `google_ads:high_cost_per_conversion:${customerId}`,
      category: "budget_waste",
      nature: "technical_issue",
      severity: "high",
      confidenceScore: 70,
      title: "Google Ads cost per conversion is high",
      observation: `Cost per conversion is €${costPerConversion.toFixed(2)} over ${dateRange} (${totals.conversions} conversion(s), €${(totals.costCents / 100).toFixed(2)} spent).`,
      rootCause:
        "Could be inefficient targeting, high competition on current keywords, or a low landing page conversion rate.",
      businessImpact: "High cost per conversion reduces campaign profitability for a chauffeur service with fixed margins.",
      financialImpact: {
        amount: costPerConversion,
        currency: "EUR",
        period: "weekly",
        direction: "cost",
        note: "Estimated cost per conversion this period.",
      },
      recommendedActions: [
        "Review keyword/audience targeting for underperforming campaigns",
        "Check Quality Score for the affected campaigns",
        "Consider pausing or reallocating budget away from the least efficient campaigns",
      ],
      requiresApproval: false,
      expectedBenefit: "Lowering cost per conversion preserves margin on the same ad spend.",
      evidence: {
        customerId,
        dateRange,
        costCents: totals.costCents,
        conversions: totals.conversions,
        costPerConversion,
      },
    });
  }

  if (totals.impressions >= MIN_IMPRESSIONS_FOR_CTR_CHECK && totals.ctr > 0 && totals.ctr < LOW_CTR_THRESHOLD) {
    drafts.push({
      dedupeKey: `google_ads:low_ctr:${customerId}`,
      category: "quality_score",
      nature: "technical_issue",
      severity: "medium",
      confidenceScore: 60,
      title: "Google Ads click-through rate is low",
      observation: `CTR is ${(totals.ctr * 100).toFixed(2)}% over ${dateRange} (${totals.impressions} impressions).`,
      rootCause: "Ad copy may not be relevant to the targeted keywords, or targeting is too broad.",
      businessImpact: "Low CTR typically lowers Quality Score, which increases cost per click over time.",
      financialImpact: null,
      recommendedActions: [
        "Review ad copy relevance against targeted keywords",
        "Check for overly broad match types driving irrelevant impressions",
      ],
      requiresApproval: false,
      expectedBenefit: "Improving CTR typically lowers cost per click via a better Quality Score.",
      evidence: { customerId, dateRange, ctr: totals.ctr, impressions: totals.impressions },
    });
  }

  return drafts;
}
