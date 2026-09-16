// Policy/Safety Engine — pure functions only, no I/O, no DB, no HTTP. The
// orchestrator (packages/core/src/bos-agent/orchestrator.ts) calls
// evaluatePolicy() between DECISION and ACTION on every proposed tool call,
// and persists the result to the audit log regardless of the outcome.
//
// Deliberately does not trust a tool's own riskLevel/requiresApproval
// declaration alone (see ToolDefinition in tools.ts) — a bug, or a future
// tool added without enough care, could under-declare its own risk. The
// hardcoded category rules below are a second, independent check that no
// tool can opt out of by simply not declaring itself dangerous.

export const riskLevels = [
  "read_only",
  "low_risk",
  "reversible",
  "requires_approval",
  "high_risk",
  "forbidden",
] as const;

export type RiskLevel = (typeof riskLevels)[number];

// What KIND of real-world effect an action has — orthogonal to riskLevel
// (a tool's own self-assessment). The deny-list/require-approval rules
// below key off this, not off riskLevel, specifically so a mis-declared
// riskLevel can never bypass them.
export const actionCategories = [
  "read",
  "content_generation",
  "content_publish",
  "booking_recommendation",
  "booking_mutation",
  "price_change",
  "budget_change",
  "spend",
  "delete",
  "secret_change",
  "follow_up",
] as const;

export type ActionCategory = (typeof actionCategories)[number];

// Never executable by any agent, ever — not even with human approval. No
// legitimate BOS Agent tool should ever be registered with this category;
// if one ever is, this is the backstop that refuses it outright.
const ALWAYS_FORBIDDEN = new Set<ActionCategory>(["secret_change"]);

// Always requires human approval before ACTION runs, regardless of what the
// tool itself declares — per the founder's explicit safety rules: budget
// increases, spend, strategic price changes, data/booking cancellation,
// booking mutation.
const ALWAYS_REQUIRES_APPROVAL = new Set<ActionCategory>([
  "price_change",
  "budget_change",
  "spend",
  "delete",
  "booking_mutation",
]);

export interface PolicyThresholds {
  // An amount at or below this is eligible for auto-approval (still only if
  // nothing else about the action requires approval); above it, approval is
  // always required. Default posture is 0 — no monetary action is
  // auto-approved unless a tenant/config explicitly raises this.
  maxAutoApprovedAmountCents: number;
}

export const DEFAULT_POLICY_THRESHOLDS: PolicyThresholds = {
  maxAutoApprovedAmountCents: 0,
};

export interface PolicyAction {
  toolName: string;
  category: ActionCategory;
  riskLevel: RiskLevel;
  // The tool's own claim — one input among several, never decisive alone
  // for the categories above.
  requiresApproval: boolean;
  reversible: boolean;
  amountCents?: number;
}

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

export function evaluatePolicy(
  action: PolicyAction,
  thresholds: PolicyThresholds = DEFAULT_POLICY_THRESHOLDS,
): PolicyDecision {
  if (ALWAYS_FORBIDDEN.has(action.category)) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `action category '${action.category}' is categorically forbidden and cannot be executed by any agent`,
    };
  }

  if (action.riskLevel === "forbidden") {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `tool '${action.toolName}' declares riskLevel 'forbidden'`,
    };
  }

  const reasons: string[] = [];
  let requiresApproval = false;

  if (ALWAYS_REQUIRES_APPROVAL.has(action.category)) {
    requiresApproval = true;
    reasons.push(`category '${action.category}' always requires approval`);
  }

  if (!action.reversible) {
    requiresApproval = true;
    reasons.push("action is irreversible");
  }

  if (action.riskLevel === "high_risk" || action.riskLevel === "requires_approval") {
    requiresApproval = true;
    reasons.push(`tool declares riskLevel '${action.riskLevel}'`);
  }

  if (action.requiresApproval) {
    requiresApproval = true;
    reasons.push(`tool '${action.toolName}' declares requiresApproval`);
  }

  if (action.amountCents != null && action.amountCents > thresholds.maxAutoApprovedAmountCents) {
    requiresApproval = true;
    reasons.push(
      `amountCents ${action.amountCents} exceeds maxAutoApprovedAmountCents ${thresholds.maxAutoApprovedAmountCents}`,
    );
  }

  if (!requiresApproval) {
    return { allowed: true, requiresApproval: false, reason: "auto-approved: read-only/low-risk/reversible action" };
  }

  return { allowed: true, requiresApproval: true, reason: reasons.join("; ") };
}
