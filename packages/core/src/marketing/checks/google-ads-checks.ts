import {
  fetchGoogleAdsWeeklyPerformance,
  fetchGoogleAdsCampaignComparison,
  fetchGoogleAdsSearchTerms,
} from "../google-clients";
import type { GoogleAdsCampaignComparisonRow, GoogleAdsSearchTermRow } from "../google-clients";
import type { FindingDraft } from "../rule-types";

// Account-level totals (below) were originally written against documented
// shapes only. The campaign-level checks further down were built after a
// real read-only GAQL call against Production's linked account (2026-08-27)
// confirmed the exact field/response shape — including that metrics.ctr and
// metrics.averageCpc are omitted entirely, not present as 0, for any
// campaign with zero clicks/impressions in the window (see parseCampaignRow
// in google-clients.ts).

const MIN_SPEND_FOR_COST_PER_CONVERSION_CENTS = 5000; // €50
const HIGH_COST_PER_CONVERSION_CENTS = 15000; // €150 — same threshold used previously in the (now retired) analytics.ts anomaly rule
const ZERO_CONVERSION_SPEND_THRESHOLD_CENTS = 5000; // €50
const MIN_IMPRESSIONS_FOR_CTR_CHECK = 100;
const LOW_CTR_THRESHOLD = 0.01;

// ── Campaign-level checks ────────────────────────────────────────────
// Thresholds reused/derived from values already established elsewhere in
// this codebase, not invented fresh:
// - MIN_PREVIOUS_PERIOD_SPEND_CENTS reuses the same €50 floor already used
//   above for account-level zero-conversion/cost-per-conversion checks, as
//   the "is the previous period a meaningful baseline" gate.
// - SIGNIFICANT_CHANGE_THRESHOLD (50%) reuses the exact same magnitude as
//   ga4-checks.ts's TRAFFIC_DROP_THRESHOLD, applied symmetrically here to
//   spend/CPC/CPA/conversions instead of GA4 sessions — one coherent
//   "significant week-over-week change" definition reused across the whole
//   engine, rather than a different bespoke percentage per metric.
// - MIN_PREVIOUS_PERIOD_CONVERSIONS has no existing precedent to reuse in
//   this codebase (conversions are a different, much rarer unit than
//   sessions or spend) — set conservatively pending the founder's own
//   read on what a statistically meaningful conversion baseline is for
//   this account's actual volume.
const MIN_PREVIOUS_PERIOD_SPEND_CENTS = MIN_SPEND_FOR_COST_PER_CONVERSION_CENTS; // €50
const SIGNIFICANT_CHANGE_THRESHOLD = 0.5; // 50%, reused from ga4-checks.ts's TRAFFIC_DROP_THRESHOLD
const MIN_PREVIOUS_PERIOD_CONVERSIONS = 3; // no existing precedent — flagged to the founder, see report

function pctChange(recent: number, previous: number): number {
  return (recent - previous) / previous;
}

export function runCampaignChecks(
  customerId: string,
  comparison: GoogleAdsCampaignComparisonRow[],
): FindingDraft[] {
  const drafts: FindingDraft[] = [];

  for (const row of comparison) {
    const {
      campaignId,
      campaignName,
      recentCostCents,
      recentConversions,
      recentClicks,
      previousCostCents,
      previousConversions,
      previousClicks,
      recentAverageCpc,
      previousAverageCpc,
    } = row;

    // 1. Spend without conversions — same €50/7-day threshold as the
    // account-level version, applied per campaign so a single wasteful
    // campaign isn't diluted into a healthy account-level total.
    if (recentCostCents >= ZERO_CONVERSION_SPEND_THRESHOLD_CENTS && recentConversions === 0) {
      drafts.push({
        dedupeKey: `google_ads_campaign_spend_no_conversion:${campaignId}`,
        category: "account_health",
        nature: "technical_issue",
        severity: "critical",
        confidenceScore: 85,
        title: `Campaign "${campaignName}" is spending with zero conversions`,
        observation: `Campaign "${campaignName}" (${campaignId}) spent €${(recentCostCents / 100).toFixed(2)} over the last 7 days across ${recentClicks} click(s) with 0 conversions recorded.`,
        rootCause:
          "Likely a conversion tracking gap for this specific campaign, search terms that don't match real booking intent, or a landing page/offer mismatch.",
        businessImpact: "This campaign's spend is not producing any measurable leads or bookings.",
        financialImpact: {
          amount: recentCostCents / 100,
          currency: "EUR",
          period: "weekly",
          direction: "cost",
          note: "Spend with no recorded conversions this period, this campaign only.",
        },
        recommendedActions: [
          "Analyze this campaign's search terms and pause/exclude queries that aren't genuinely booking-intent",
          "Confirm conversion tracking fires correctly for this campaign specifically before increasing its budget",
        ],
        requiresApproval: false,
        expectedBenefit: "Stops wasted spend on this campaign until it demonstrably converts.",
        evidence: { customerId, campaignId, campaignName, costCents: recentCostCents, clicks: recentClicks },
      });
    }

    // 2. Spend anomaly (spike or drop) vs the prior comparable 7-day window.
    if (previousCostCents >= MIN_PREVIOUS_PERIOD_SPEND_CENTS) {
      const change = pctChange(recentCostCents, previousCostCents);
      if (Math.abs(change) >= SIGNIFICANT_CHANGE_THRESHOLD) {
        const direction = change > 0 ? "increased" : "decreased";
        drafts.push({
          dedupeKey: `google_ads_campaign_spend_anomaly:${campaignId}`,
          category: "budget_pacing",
          nature: "technical_issue",
          severity: change > 0 ? "high" : "medium",
          confidenceScore: 70,
          title: `Campaign "${campaignName}" spend ${direction} sharply week-over-week`,
          observation: `Campaign "${campaignName}" (${campaignId}) spent €${(recentCostCents / 100).toFixed(2)} in the last 7 days vs €${(previousCostCents / 100).toFixed(2)} in the prior 7 days (${(change * 100).toFixed(0)}% change).`,
          rootCause:
            change > 0
              ? "A bid/budget change, increased competition, or a broad-match keyword picking up expensive traffic."
              : "A budget cap being hit, a paused ad/keyword, or reduced auction eligibility (e.g. low Quality Score, disapproval).",
          businessImpact:
            change > 0
              ? "Spend is accelerating faster than usual — worth confirming it's intentional before it compounds."
              : "This campaign may be under-delivering relative to its allocated budget, losing potential bookings.",
          financialImpact: {
            amount: Math.abs(recentCostCents - previousCostCents) / 100,
            currency: "EUR",
            period: "weekly",
            direction: change > 0 ? "cost" : "opportunity",
            note: `Week-over-week spend ${direction} for this campaign.`,
          },
          recommendedActions:
            change > 0
              ? [
                  "Check recent bid/budget changes for this campaign",
                  "Review search terms for newly-appearing expensive/irrelevant queries",
                ]
              : [
                  "Check the campaign's budget cap and whether it's being hit (limited by budget)",
                  "Check for paused ads/keywords or new disapprovals",
                ],
          requiresApproval: false,
          expectedBenefit: "Confirms whether the spend change is intentional or needs correction.",
          evidence: { customerId, campaignId, campaignName, recentCostCents, previousCostCents, changePct: change },
        });
      }
    }

    // 3. CPC anomaly — only meaningful when both windows actually had
    // clicks (averageCpc is 0/undefined otherwise, not a real "free" CPC).
    if (previousClicks > 0 && recentClicks > 0 && previousAverageCpc > 0) {
      const change = pctChange(recentAverageCpc, previousAverageCpc);
      if (Math.abs(change) >= SIGNIFICANT_CHANGE_THRESHOLD) {
        const direction = change > 0 ? "increased" : "decreased";
        drafts.push({
          dedupeKey: `google_ads_campaign_cpc_anomaly:${campaignId}`,
          category: "bid_cpc_anomaly",
          nature: "technical_issue",
          severity: "medium",
          confidenceScore: 65,
          title: `Campaign "${campaignName}" average CPC ${direction} sharply`,
          observation: `Campaign "${campaignName}" (${campaignId}) average CPC is €${recentAverageCpc.toFixed(2)} over the last 7 days vs €${previousAverageCpc.toFixed(2)} in the prior 7 days (${(change * 100).toFixed(0)}% change).`,
          rootCause:
            change > 0
              ? "Increased auction competition, a Quality Score drop, or a bid strategy change."
              : "Reduced competition, a Quality Score improvement, or a bid strategy change.",
          businessImpact:
            change > 0
              ? "Each click now costs more — the same budget buys fewer clicks unless conversion rate compensates."
              : "Each click now costs less — worth confirming traffic quality hasn't degraded alongside it.",
          financialImpact: null,
          recommendedActions:
            change > 0
              ? ["Check Quality Score and ad relevance for this campaign", "Review recent bid strategy changes"]
              : ["Confirm traffic quality/relevance hasn't dropped alongside the lower CPC"],
          requiresApproval: false,
          expectedBenefit: "Identifying the cause allows correcting cost-per-click before it compounds.",
          evidence: { customerId, campaignId, campaignName, recentAverageCpc, previousAverageCpc, changePct: change },
        });
      }
    }

    // 4. Conversion drop — needs a real baseline (see
    // MIN_PREVIOUS_PERIOD_CONVERSIONS) so a single lost conversion on a
    // near-zero baseline isn't reported as a "50%+ drop".
    if (previousConversions >= MIN_PREVIOUS_PERIOD_CONVERSIONS) {
      const change = pctChange(recentConversions, previousConversions);
      if (change <= -SIGNIFICANT_CHANGE_THRESHOLD) {
        drafts.push({
          dedupeKey: `google_ads_campaign_conversion_drop:${campaignId}`,
          category: "account_health",
          nature: "technical_issue",
          severity: "high",
          confidenceScore: 70,
          title: `Campaign "${campaignName}" conversions dropped sharply`,
          observation: `Campaign "${campaignName}" (${campaignId}) recorded ${recentConversions} conversion(s) over the last 7 days vs ${previousConversions} in the prior 7 days (${(change * 100).toFixed(0)}% change).`,
          rootCause:
            "Could be a conversion tracking break, a landing page/offer change, seasonality, or a genuine demand drop — cross-check against any GA4/GTM findings from this same run first.",
          businessImpact: "Fewer recorded conversions from this campaign means fewer leads/bookings from that spend.",
          financialImpact: null,
          recommendedActions: [
            "Rule out a tracking issue first (check this run's conversion_tracking/gtm_configuration findings)",
            "Check for recent landing page or offer changes tied to this campaign",
          ],
          requiresApproval: false,
          expectedBenefit: "Restoring the conversion rate recovers lead/booking volume from this campaign's spend.",
          evidence: { customerId, campaignId, campaignName, recentConversions, previousConversions, changePct: change },
        });
      }
    }

    // 5. CPA anomaly — needs a real conversion baseline in *both* windows,
    // deliberately disjoint from the conversion-drop check above (a
    // campaign whose conversions collapsed is already covered there; this
    // one is for a campaign still converting, just at a worsening cost).
    if (previousConversions >= MIN_PREVIOUS_PERIOD_CONVERSIONS && recentConversions >= MIN_PREVIOUS_PERIOD_CONVERSIONS) {
      const recentCpa = recentCostCents / recentConversions;
      const previousCpa = previousCostCents / previousConversions;
      const change = pctChange(recentCpa, previousCpa);
      if (change >= SIGNIFICANT_CHANGE_THRESHOLD) {
        drafts.push({
          dedupeKey: `google_ads_campaign_cpa_anomaly:${campaignId}`,
          category: "budget_waste",
          nature: "technical_issue",
          severity: "medium",
          confidenceScore: 65,
          title: `Campaign "${campaignName}" cost per conversion increased sharply`,
          observation: `Campaign "${campaignName}" (${campaignId}) cost per conversion is €${(recentCpa / 100).toFixed(2)} over the last 7 days vs €${(previousCpa / 100).toFixed(2)} in the prior 7 days (${(change * 100).toFixed(0)}% change), still converting in both periods.`,
          rootCause: "Higher CPC, lower conversion rate, or both, without a proportional increase in conversion value.",
          businessImpact: "This campaign is producing the same or fewer bookings for meaningfully more spend.",
          financialImpact: {
            amount: (recentCpa - previousCpa) / 100,
            currency: "EUR",
            period: "weekly",
            direction: "cost",
            note: "Increase in cost per conversion for this campaign, per conversion.",
          },
          recommendedActions: [
            "Review this campaign's search terms and keywords for newly-appearing low-intent traffic",
            "Compare against the CPC anomaly and search-term findings from this same run",
          ],
          requiresApproval: false,
          expectedBenefit: "Restoring cost per conversion improves margin on the same ad spend.",
          evidence: { customerId, campaignId, campaignName, recentCpa, previousCpa, changePct: change },
        });
      }
    }
  }

  return drafts;
}

// ── Search Term Intelligence ─────────────────────────────────────────
// Deliberately does NOT classify search-term relevance/pertinence itself —
// only Google Ads' own numbers (cost, clicks, conversions, CPA) and its own
// search_term_view.status (ADDED/EXCLUDED/NONE — whether the account owner
// already turned this term into a keyword or a negative). Whether a query
// fits Bonolini Transfer's premium positioning is a judgment call for the
// founder; the deterministic layer surfaces evidence and a REVIEW label,
// never an assertion of irrelevance (see NEGATIVE_KEYWORD_REVIEW below,
// which mirrors the founder's own worked example: "REVIEW / POSSIBILE
// NEGATIVE", not a flat "NEGATIVE").
//
// MIN_CONVERSIONS_FOR_KEYWORD_OPPORTUNITY reuses the most natural possible
// floor (>=1 full attributed conversion — Google Ads conversions can be
// fractional, e.g. 0.83, for assisted/cross-device attribution; a term that
// hasn't reached one whole conversion yet isn't a proven opportunity).
// MIN_CLICKS_FOR_ZERO_CONVERSION_REVIEW has no existing precedent to reuse
// (same situation as MIN_PREVIOUS_PERIOD_CONVERSIONS above) — flagged to
// the founder, see report. HIGH_COST_PER_CONVERSION_CENTS is the exact same
// €150 threshold already used at account level, not a new number.
const MIN_CONVERSIONS_FOR_KEYWORD_OPPORTUNITY = 1;
const MIN_CLICKS_FOR_ZERO_CONVERSION_REVIEW = 3; // no existing precedent — flagged to the founder, see report

export type SearchTermDecision =
  | "performance_problem"
  | "positive_keyword_opportunity"
  | "negative_keyword_review"
  | "keep_monitor";

export interface SearchTermClassification {
  decision: SearchTermDecision;
  costPerConversionCents: number | null;
}

// Exported for direct testing, same rationale as filterAiFindingDrafts
// (ai-analyst.ts) and severityForBaseline-style pure decision functions
// elsewhere in this package.
export function classifySearchTerm(row: GoogleAdsSearchTermRow): SearchTermClassification {
  const costPerConversionCents = row.conversions > 0 ? Math.round(row.costCents / row.conversions) : null;

  if (row.conversions > 0 && costPerConversionCents !== null && costPerConversionCents >= HIGH_COST_PER_CONVERSION_CENTS) {
    return { decision: "performance_problem", costPerConversionCents };
  }

  if (row.conversions >= MIN_CONVERSIONS_FOR_KEYWORD_OPPORTUNITY && row.status !== "ADDED") {
    return { decision: "positive_keyword_opportunity", costPerConversionCents };
  }

  if (row.conversions === 0 && row.status !== "ADDED" && row.clicks >= MIN_CLICKS_FOR_ZERO_CONVERSION_REVIEW) {
    return { decision: "negative_keyword_review", costPerConversionCents };
  }

  return { decision: "keep_monitor", costPerConversionCents };
}

// Only the three actionable decisions become findings — keep_monitor is
// "pertinent by default, insufficient data to act", the same "healthy, no
// finding" convention every other check in this module already follows.
// EXCLUDED search terms are skipped entirely: the founder already resolved
// them in Google Ads, so they're no longer "useful" (per the founder's own
// phrasing) for a new decision.
export function runSearchTermChecks(customerId: string, rows: GoogleAdsSearchTermRow[]): FindingDraft[] {
  const drafts: FindingDraft[] = [];

  for (const row of rows) {
    if (row.status === "EXCLUDED") continue;

    const { decision, costPerConversionCents } = classifySearchTerm(row);
    const costEuros = (row.costCents / 100).toFixed(2);
    const evidence = {
      customerId,
      campaignId: row.campaignId,
      campaignName: row.campaignName,
      searchTerm: row.searchTerm,
      status: row.status,
      costCents: row.costCents,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      averageCpc: row.averageCpc,
      conversions: row.conversions,
      conversionValue: row.conversionValue,
      costPerConversionCents,
    };

    if (decision === "performance_problem") {
      drafts.push({
        dedupeKey: `google_ads_search_term:${row.campaignId}:${row.normalizedSearchTerm}`,
        category: "budget_waste",
        nature: "technical_issue",
        severity: "high",
        confidenceScore: 75,
        title: `Search term "${row.searchTerm}" converts but at a high cost`,
        observation: `In campaign "${row.campaignName}", the query "${row.searchTerm}" spent €${costEuros} over the last 30 days across ${row.clicks} click(s), producing ${row.conversions} conversion(s) at €${((costPerConversionCents ?? 0) / 100).toFixed(2)} per conversion.`,
        rootCause: "The query is commercially relevant but converts inefficiently — likely broad match spillover, high competition, or a landing page mismatch specific to this intent.",
        businessImpact: "This query is a proven source of bookings, but at a cost per conversion well above the account's own €150 threshold.",
        financialImpact: {
          amount: (costPerConversionCents ?? 0) / 100,
          currency: "EUR",
          period: "monthly",
          direction: "cost",
          note: "Cost per conversion for this search term, last 30 days.",
        },
        recommendedActions: [
          "Consider adding this exact query as a dedicated keyword with its own bid, instead of relying on broad/phrase match",
          "Review the landing page shown for this query's ad group",
        ],
        requiresApproval: false,
        expectedBenefit: "Bringing this query's cost per conversion in line with the account average improves margin without losing a proven conversion source.",
        evidence,
      });
      continue;
    }

    if (decision === "positive_keyword_opportunity") {
      drafts.push({
        dedupeKey: `google_ads_search_term:${row.campaignId}:${row.normalizedSearchTerm}`,
        category: "impression_share",
        nature: "strategic_opportunity",
        severity: "low",
        confidenceScore: 70,
        title: `Search term "${row.searchTerm}" is a candidate for a dedicated keyword`,
        observation: `In campaign "${row.campaignName}", the query "${row.searchTerm}" produced ${row.conversions} conversion(s) over the last 30 days (€${costEuros} spent, ${row.clicks} click(s)) and is not yet an explicit keyword in this account (status: ${row.status}).`,
        rootCause: "Real booking intent is showing up through broad/phrase match or close variants rather than an exact, dedicated keyword.",
        businessImpact: "Without a dedicated keyword, this query's bid and budget are governed by whatever keyword happened to match it, not by its own proven value.",
        financialImpact: null,
        recommendedActions: [
          "Consider adding this exact query as its own keyword (exact match) with a bid reflecting its proven conversion value",
        ],
        requiresApproval: false,
        expectedBenefit: "A dedicated keyword gives direct bid control over a query that already demonstrably converts.",
        evidence,
      });
      continue;
    }

    if (decision === "negative_keyword_review") {
      drafts.push({
        dedupeKey: `google_ads_search_term:${row.campaignId}:${row.normalizedSearchTerm}`,
        category: "budget_waste",
        nature: "technical_issue",
        severity: "medium",
        confidenceScore: 55,
        title: `Search term "${row.searchTerm}" — review for possible negative keyword`,
        observation: `In campaign "${row.campaignName}", the query "${row.searchTerm}" received ${row.clicks} click(s) and cost €${costEuros} over the last 30 days with 0 conversions recorded.`,
        rootCause: "Zero conversions with repeated clicks over 30 days — could be genuinely irrelevant intent, or a query type that doesn't fit this campaign's positioning; cost/click data alone cannot prove which.",
        businessImpact: "This query is consuming budget without any recorded return so far.",
        financialImpact: {
          amount: row.costCents / 100,
          currency: "EUR",
          period: "monthly",
          direction: "cost",
          note: "Spend on this search term with 0 conversions, last 30 days.",
        },
        recommendedActions: [
          "Manually review this query against Bonolini Transfer's premium NCC positioning before excluding it",
          "If confirmed off-intent, add it as a negative keyword at the ad group or campaign level",
        ],
        requiresApproval: true,
        expectedBenefit: "Excluding genuinely off-intent queries stops wasted spend without risking a query that just hasn't converted yet.",
        evidence,
      });
    }
  }

  return drafts;
}

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

  const campaignComparison = await fetchGoogleAdsCampaignComparison(tenantId, customerId);
  drafts.push(...runCampaignChecks(customerId, campaignComparison));

  const searchTerms = await fetchGoogleAdsSearchTerms(tenantId, customerId);
  drafts.push(...runSearchTermChecks(customerId, searchTerms));

  return drafts;
}
