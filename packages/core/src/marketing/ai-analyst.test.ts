import { describe, expect, it, vi, beforeEach } from "vitest";
import type { FindingDraft } from "./rule-types";

const runStrategistSynthesis = vi.fn();

vi.mock("./strategist", () => ({
  runStrategistSynthesis: (...args: unknown[]) => runStrategistSynthesis(...args),
}));

const { runGoogleMarketingAnalyst } = await import("./ai-analyst");

const validFinding: FindingDraft = {
  dedupeKey: "claude:account_health:test-finding",
  category: "account_health",
  nature: "technical_issue",
  severity: "high",
  confidenceScore: 75,
  title: "Test strategic finding",
  observation: "Something a senior consultant would notice.",
  businessImpact: "Some business impact.",
  recommendedActions: ["Do something"],
  requiresApproval: false,
};

describe("ai-analyst (runGoogleMarketingAnalyst)", () => {
  beforeEach(() => {
    runStrategistSynthesis.mockReset();
  });

  it("returns findings produced by the injected synthesis implementation", async () => {
    runStrategistSynthesis.mockResolvedValue([validFinding]);

    const result = await runGoogleMarketingAnalyst("tenant-1", [], "caller-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      dedupeKey: "claude:account_health:test-finding",
      category: "account_health",
    });
  });

  it("drops malformed entries instead of propagating them", async () => {
    const malformed = { ...validFinding, category: "not_a_real_category", dedupeKey: "claude:bad:entry" };
    runStrategistSynthesis.mockResolvedValue([validFinding, malformed]);

    const result = await runGoogleMarketingAnalyst("tenant-1", [], "caller-1");

    expect(result).toHaveLength(1);
    expect(result[0]?.dedupeKey).toBe("claude:account_health:test-finding");
  });

  it("fails soft (returns []) when the underlying synthesis throws", async () => {
    runStrategistSynthesis.mockRejectedValue(new Error("ANTHROPIC_API_KEY invalid or network error"));

    const result = await runGoogleMarketingAnalyst("tenant-1", [], "caller-1");

    expect(result).toEqual([]);
  });

  it("can be invoked more than once per process without a double-registration error", async () => {
    runStrategistSynthesis.mockResolvedValue([]);

    await expect(runGoogleMarketingAnalyst("tenant-1", [], "caller-1")).resolves.toEqual([]);
    await expect(runGoogleMarketingAnalyst("tenant-1", [], "caller-1")).resolves.toEqual([]);
  });
});
