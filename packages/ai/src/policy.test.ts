import { describe, expect, it } from "vitest";
import { evaluatePolicy, DEFAULT_POLICY_THRESHOLDS, type PolicyAction } from "./policy";

function action(overrides: Partial<PolicyAction> = {}): PolicyAction {
  return {
    toolName: "test.tool",
    category: "read",
    riskLevel: "read_only",
    requiresApproval: false,
    reversible: true,
    ...overrides,
  };
}

describe("evaluatePolicy — auto-approved paths", () => {
  it("auto-approves a plain read-only, reversible, low-risk action", () => {
    const decision = evaluatePolicy(action());
    expect(decision).toEqual({ allowed: true, requiresApproval: false, reason: expect.any(String), tier: "READ_ONLY" });
  });

  it("auto-approves a low-risk reversible action even if not strictly 'read'", () => {
    const decision = evaluatePolicy(action({ category: "content_generation", riskLevel: "low_risk" }));
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });
});

describe("evaluatePolicy — V2 tier computation (determined by the engine, never read back from the tool)", () => {
  it("computes READ_ONLY for an allowed, no-approval action in the 'read' category", () => {
    expect(evaluatePolicy(action({ category: "read" })).tier).toBe("READ_ONLY");
  });

  it("computes PREPARE for an allowed, no-approval content_generation/follow_up action", () => {
    expect(evaluatePolicy(action({ category: "content_generation", riskLevel: "low_risk" })).tier).toBe("PREPARE");
    expect(evaluatePolicy(action({ category: "follow_up", riskLevel: "low_risk" })).tier).toBe("PREPARE");
  });

  it("computes AUTONOMOUS_SAFE for an allowed, no-approval action outside read/content_generation/follow_up", () => {
    expect(evaluatePolicy(action({ category: "booking_recommendation", riskLevel: "low_risk" })).tier).toBe(
      "AUTONOMOUS_SAFE",
    );
  });

  it("computes REQUIRES_APPROVAL whenever approval is needed, regardless of category", () => {
    expect(evaluatePolicy(action({ category: "price_change" })).tier).toBe("REQUIRES_APPROVAL");
  });

  it("computes DENIED whenever the action is disallowed, regardless of category", () => {
    expect(evaluatePolicy(action({ category: "secret_change" })).tier).toBe("DENIED");
  });

  it("never trusts a tool's own riskLevel to produce a tier more permissive than the category allows", () => {
    // A tool claiming to be read_only/low-risk in a forbidden category still ends up DENIED.
    const decision = evaluatePolicy(
      action({ category: "secret_change", riskLevel: "read_only", requiresApproval: false, reversible: true }),
    );
    expect(decision.tier).toBe("DENIED");
  });
});

describe("evaluatePolicy — allowedAgents enforcement (Action Registry, V2)", () => {
  it("denies when the calling agent is not among the tool's allowedAgents", () => {
    const decision = evaluatePolicy(action({ callerAgent: "marketing", allowedAgents: ["social"] }));
    expect(decision.allowed).toBe(false);
    expect(decision.tier).toBe("DENIED");
    expect(decision.reason).toContain("marketing");
    expect(decision.reason).toContain("not among the agents allowed");
  });

  it("allows when the calling agent is among the tool's allowedAgents", () => {
    const decision = evaluatePolicy(action({ callerAgent: "social", allowedAgents: ["social", "operations"] }));
    expect(decision.allowed).toBe(true);
  });

  it("skips the allowedAgents check entirely when either side omits it — a tool with no allowedAgents list is unrestricted by this rule", () => {
    const decision = evaluatePolicy(action({ callerAgent: "marketing" }));
    expect(decision.allowed).toBe(true);
  });

  it("is checked before the category deny-list, but produces the same DENIED tier either way", () => {
    const decision = evaluatePolicy(action({ callerAgent: "marketing", allowedAgents: ["social"], category: "read" }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).not.toContain("secret_change");
  });
});

describe("evaluatePolicy — hardcoded category deny-list (never trusts the tool's own declaration alone)", () => {
  it("forbids secret_change categorically, even if the tool itself claims read_only/reversible/no-approval-needed", () => {
    const decision = evaluatePolicy(
      action({ category: "secret_change", riskLevel: "read_only", requiresApproval: false, reversible: true }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.reason).toContain("secret_change");
  });

  it("always requires approval for price_change even when the tool under-declares itself as low_risk/no-approval", () => {
    const decision = evaluatePolicy(
      action({ category: "price_change", riskLevel: "low_risk", requiresApproval: false, reversible: true }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
  });

  it("always requires approval for budget_change regardless of self-declaration", () => {
    const decision = evaluatePolicy(
      action({ category: "budget_change", riskLevel: "read_only", requiresApproval: false, reversible: true }),
    );
    expect(decision.requiresApproval).toBe(true);
  });

  it("always requires approval for spend regardless of self-declaration", () => {
    const decision = evaluatePolicy(action({ category: "spend", requiresApproval: false }));
    expect(decision.requiresApproval).toBe(true);
  });

  it("always requires approval for delete regardless of self-declaration", () => {
    const decision = evaluatePolicy(action({ category: "delete", requiresApproval: false }));
    expect(decision.requiresApproval).toBe(true);
  });

  it("always requires approval for booking_mutation regardless of self-declaration", () => {
    const decision = evaluatePolicy(action({ category: "booking_mutation", requiresApproval: false }));
    expect(decision.requiresApproval).toBe(true);
  });

  // Phase 3 — outbound customer communications (packages/core/src/communications):
  // never auto-sent, regardless of what the caller declares, even a
  // read_only/reversible/no-approval-needed self-declaration.
  it("always requires approval for customer_communication regardless of self-declaration", () => {
    const decision = evaluatePolicy(
      action({ category: "customer_communication", riskLevel: "read_only", requiresApproval: false, reversible: true }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.tier).toBe("REQUIRES_APPROVAL");
  });
});

describe("evaluatePolicy — riskLevel and reversibility", () => {
  it("denies outright when the tool declares riskLevel 'forbidden'", () => {
    const decision = evaluatePolicy(action({ riskLevel: "forbidden" }));
    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(false);
  });

  it("requires approval when the tool declares riskLevel 'high_risk'", () => {
    const decision = evaluatePolicy(action({ riskLevel: "high_risk" }));
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
  });

  it("requires approval when the tool declares riskLevel 'requires_approval'", () => {
    const decision = evaluatePolicy(action({ riskLevel: "requires_approval" }));
    expect(decision.requiresApproval).toBe(true);
  });

  it("requires approval for any irreversible action, even if otherwise read/low-risk", () => {
    const decision = evaluatePolicy(action({ reversible: false }));
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reason).toContain("irreversible");
  });

  it("requires approval when the tool itself declares requiresApproval true", () => {
    const decision = evaluatePolicy(action({ requiresApproval: true }));
    expect(decision.requiresApproval).toBe(true);
  });
});

describe("evaluatePolicy — monetary thresholds", () => {
  it("requires approval for any amount above the default zero threshold", () => {
    const decision = evaluatePolicy(action({ category: "spend", amountCents: 100 }), DEFAULT_POLICY_THRESHOLDS);
    expect(decision.requiresApproval).toBe(true);
  });

  it("auto-approves an amount at or below a configured non-zero threshold, if nothing else gates it", () => {
    const decision = evaluatePolicy(action({ amountCents: 500 }), { maxAutoApprovedAmountCents: 1000 });
    expect(decision.requiresApproval).toBe(false);
  });

  it("still requires approval above a configured non-zero threshold", () => {
    const decision = evaluatePolicy(action({ amountCents: 1500 }), { maxAutoApprovedAmountCents: 1000 });
    expect(decision.requiresApproval).toBe(true);
  });
});
