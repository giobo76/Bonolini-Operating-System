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
    expect(decision).toEqual({ allowed: true, requiresApproval: false, reason: expect.any(String) });
  });

  it("auto-approves a low-risk reversible action even if not strictly 'read'", () => {
    const decision = evaluatePolicy(action({ category: "content_generation", riskLevel: "low_risk" }));
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
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
