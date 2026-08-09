import type { Finding } from "@bos/db";
import type { FinancialImpact } from "./schema";

export interface HealthScoreBreakdown {
  trackingIntegrity: number;
  accountHealth: number;
  efficiency: number;
  technicalSiteHealth: number;
}

export interface OpportunityValueItem {
  amount: number;
  currency: string;
  period: "one_time" | "daily" | "weekly" | "monthly";
}

export interface HealthScoreResult {
  overall: number;
  breakdown: HealthScoreBreakdown;
  opportunityValue: OpportunityValueItem[];
}

type Component = keyof HealthScoreBreakdown;

// Every finding category maps to exactly one Health Score component. If a
// case can genuinely belong to more than one, that's a sign the category
// list itself needs a new entry — not a reason to make this a many-to-many
// map, which would make the score harder to explain.
const CATEGORY_COMPONENT: Record<Finding["category"], Component> = {
  conversion_tracking: "trackingIntegrity",
  duplicate_conversions: "trackingIntegrity",
  attribution: "trackingIntegrity",
  gtm_configuration: "trackingIntegrity",
  form_tracking: "trackingIntegrity",
  call_tracking: "trackingIntegrity",
  whatsapp_tracking: "trackingIntegrity",
  budget_pacing: "accountHealth",
  policy_compliance: "accountHealth",
  account_health: "accountHealth",
  budget_waste: "efficiency",
  bid_cpc_anomaly: "efficiency",
  quality_score: "efficiency",
  impression_share: "efficiency",
  competitor_observation: "efficiency",
  landing_page_availability: "technicalSiteHealth",
  page_speed: "technicalSiteHealth",
  core_web_vitals: "technicalSiteHealth",
  search_console_indexing: "technicalSiteHealth",
  organic_traffic: "technicalSiteHealth",
  other: "accountHealth",
};

// Tracking integrity is weighted highest on purpose: if the data can't be
// trusted, nothing else the engine reports can be trusted either.
const COMPONENT_WEIGHTS: Record<Component, number> = {
  trackingIntegrity: 0.35,
  accountHealth: 0.25,
  efficiency: 0.25,
  technicalSiteHealth: 0.15,
};

const SEVERITY_PENALTY: Record<Finding["severity"], number> = {
  critical: 25,
  high: 12,
  medium: 5,
  low: 2,
};

// A strategic opportunity is unrealized upside, not active harm — it
// penalizes its component much more lightly than a technical issue of the
// same severity. Its financial upside is surfaced separately as
// "opportunity value" instead of being folded into this deduction.
const NATURE_MULTIPLIER: Record<Finding["nature"], number> = {
  technical_issue: 1,
  strategic_opportunity: 0.25,
};

export function computeHealthScore(
  openFindings: Pick<Finding, "category" | "severity" | "nature" | "financialImpact">[],
): HealthScoreResult {
  const breakdown: HealthScoreBreakdown = {
    trackingIntegrity: 100,
    accountHealth: 100,
    efficiency: 100,
    technicalSiteHealth: 100,
  };

  for (const finding of openFindings) {
    const component = CATEGORY_COMPONENT[finding.category];
    const penalty = SEVERITY_PENALTY[finding.severity] * NATURE_MULTIPLIER[finding.nature];
    breakdown[component] = Math.max(0, breakdown[component] - penalty);
  }

  const overall = Math.round(
    (Object.entries(COMPONENT_WEIGHTS) as [Component, number][]).reduce(
      (sum, [component, weight]) => sum + breakdown[component] * weight,
      0,
    ),
  );

  const opportunityValue: OpportunityValueItem[] = openFindings
    .filter((f): f is typeof f & { financialImpact: FinancialImpact } => {
      const impact = f.financialImpact as FinancialImpact | null;
      return f.nature === "strategic_opportunity" && !!impact?.amount;
    })
    .map((f) => {
      const impact = f.financialImpact as FinancialImpact;
      return { amount: impact.amount as number, currency: impact.currency, period: impact.period };
    });

  return { overall, breakdown, opportunityValue };
}
