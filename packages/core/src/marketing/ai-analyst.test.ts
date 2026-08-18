import { describe, expect, it, vi, beforeEach } from "vitest";
import type { FindingDraft } from "./rule-types";

const runStrategistSynthesis = vi.fn();

vi.mock("./strategist", () => ({
  runStrategistSynthesis: (...args: unknown[]) => runStrategistSynthesis(...args),
}));

const { runGoogleMarketingAnalyst, filterAiFindingDrafts } = await import("./ai-analyst");

// category "other" deliberately: it carries no finding-quality evidence gate
// (see ai-analyst.ts), so these generic wiring tests (malformed-entry
// dropping, fail-soft behavior, etc.) aren't incidentally affected by that
// unrelated feature.
const validFinding: FindingDraft = {
  dedupeKey: "claude:other:test-finding",
  category: "other",
  nature: "technical_issue",
  severity: "high",
  confidenceScore: 75,
  title: "Test strategic finding",
  observation: "Something a senior consultant would notice.",
  businessImpact: "Some business impact.",
  recommendedActions: ["Do something"],
  requiresApproval: false,
};

// Minimal, deliberately loose factory — only the fields the quality gate
// actually inspects (category, dedupeKey, severity) vary per test; the rest
// are fixed filler that satisfies the FindingDraft shape.
function draft(overrides: Partial<FindingDraft> & Pick<FindingDraft, "category" | "dedupeKey">): FindingDraft {
  return {
    nature: "technical_issue",
    severity: "medium",
    confidenceScore: 50,
    title: "Test finding",
    observation: "Test observation.",
    businessImpact: "Test business impact.",
    recommendedActions: [],
    requiresApproval: false,
    ...overrides,
  };
}

describe("ai-analyst (runGoogleMarketingAnalyst)", () => {
  beforeEach(() => {
    runStrategistSynthesis.mockReset();
  });

  it("returns findings produced by the injected synthesis implementation", async () => {
    runStrategistSynthesis.mockResolvedValue([validFinding]);

    const result = await runGoogleMarketingAnalyst("tenant-1", [], "caller-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      dedupeKey: "claude:other:test-finding",
      category: "other",
    });
  });

  it("drops malformed entries instead of propagating them", async () => {
    const malformed = { ...validFinding, category: "not_a_real_category", dedupeKey: "claude:bad:entry" };
    runStrategistSynthesis.mockResolvedValue([validFinding, malformed]);

    const result = await runGoogleMarketingAnalyst("tenant-1", [], "caller-1");

    expect(result).toHaveLength(1);
    expect(result[0]?.dedupeKey).toBe("claude:other:test-finding");
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

  // Regression: proves the quality gate (filterAiFindingDrafts) is actually
  // wired into the return path, not just defined and unused. The candidate
  // below would pass findingLikeSchema validation fine — it's blocked by
  // the gate, not by malformed-entry filtering (already covered above).
  it("applies the finding-quality gate to what the synthesis returns (organic_traffic restating an active GA4 drop is blocked)", async () => {
    const deterministicDrafts: FindingDraft[] = [
      draft({ category: "organic_traffic", dedupeKey: "ga4_traffic_drop:524948086" }),
    ];
    runStrategistSynthesis.mockResolvedValue([
      draft({ category: "organic_traffic", dedupeKey: "claude:organic_traffic:Some restated commentary" }),
    ]);

    const result = await runGoogleMarketingAnalyst("tenant-1", deterministicDrafts, "caller-1");

    expect(result).toEqual([]);
  });
});

describe("filterAiFindingDrafts", () => {
  // TEST 1 — real 18/08 case: GA4 traffic-drop deterministic draft present
  // this run -> a claude:organic_traffic candidate restating it is blocked.
  it("TEST1: blocks organic_traffic when a ga4_traffic_drop draft exists this run", () => {
    const deterministic = [draft({ category: "organic_traffic", dedupeKey: "ga4_traffic_drop:524948086" })];
    const candidate = draft({ category: "organic_traffic", dedupeKey: "claude:organic_traffic:Root-cause triage needed" });

    expect(filterAiFindingDrafts([candidate], deterministic)).toEqual([]);
  });

  // TEST 2 — same underlying signal, differently-worded candidate (proves
  // the block is keyed on category+evidence prefix, not on title text).
  it("TEST2: blocks a differently-worded organic_traffic candidate while the same GA4 signal is active", () => {
    const deterministic = [draft({ category: "organic_traffic", dedupeKey: "ga4_traffic_drop:524948086" })];
    const candidate = draft({
      category: "organic_traffic",
      dedupeKey: "claude:organic_traffic:Statistical significance is limited given very low traffic volume",
    });

    expect(filterAiFindingDrafts([candidate], deterministic)).toEqual([]);
  });

  // TEST 3 — no GSC deterministic signal this run -> search_console_indexing blocked.
  it("TEST3: blocks search_console_indexing when no gsc_* draft exists this run", () => {
    const deterministic: FindingDraft[] = [];
    const candidate = draft({
      category: "search_console_indexing",
      dedupeKey: "claude:search_console_indexing:Cross-check indexing",
    });

    expect(filterAiFindingDrafts([candidate], deterministic)).toEqual([]);
  });

  // TEST 4 — real 18/08 case: no Google Ads draft this run -> budget_waste blocked.
  it("TEST4: blocks budget_waste when no google_ads:* draft exists this run", () => {
    const deterministic: FindingDraft[] = [
      draft({ category: "organic_traffic", dedupeKey: "ga4_traffic_drop:524948086" }), // unrelated signal present
    ];
    const candidate = draft({
      category: "budget_waste",
      dedupeKey: "claude:budget_waste:Consider whether paid channels should absorb the shortfall",
    });

    expect(filterAiFindingDrafts([candidate], deterministic)).toEqual([]);
  });

  // TEST 5 — evidence-gated category WITH real evidence this run and no
  // conflicting rule: must be created. Proves the gate isn't a blanket
  // "disable the AI Analyst" switch.
  it("TEST5: allows budget_waste when a google_ads:* draft provides real evidence this run", () => {
    const deterministic = [
      draft({ category: "budget_waste", dedupeKey: "google_ads:high_cost_per_conversion:6780187978" }),
    ];
    const candidate = draft({
      category: "budget_waste",
      dedupeKey: "claude:budget_waste:Reallocate spend given high cost per conversion",
      severity: "medium",
    });

    const result = filterAiFindingDrafts([candidate], deterministic);

    expect(result).toHaveLength(1);
    expect(result[0]?.dedupeKey).toBe("claude:budget_waste:Reallocate spend given high cost per conversion");
  });

  // TEST 7 — severity clamp. Category "other" carries no evidence gate at
  // all, isolating this assertion from the gating rules above.
  it("TEST7: clamps critical/high severity from Claude down to medium", () => {
    const critical = draft({ category: "other", dedupeKey: "claude:other:Urgent-sounding observation", severity: "critical" });
    const high = draft({ category: "other", dedupeKey: "claude:other:Another urgent-sounding observation", severity: "high" });
    const low = draft({ category: "other", dedupeKey: "claude:other:A minor note", severity: "low" });

    const result = filterAiFindingDrafts([critical, high, low], []);

    expect(result.find((f) => f.dedupeKey === critical.dedupeKey)?.severity).toBe("medium");
    expect(result.find((f) => f.dedupeKey === high.dedupeKey)?.severity).toBe("medium");
    expect(result.find((f) => f.dedupeKey === low.dedupeKey)?.severity).toBe("low"); // never raised, only capped
  });

  // Proves the gate doesn't globally disable the AI Analyst: a category
  // with no evidence-gate rule at all always passes through untouched.
  it("passes through findings in categories with no gate at all, regardless of this run's drafts", () => {
    const candidate = draft({ category: "other", dedupeKey: "claude:other:A genuinely new observation" });

    expect(filterAiFindingDrafts([candidate], [])).toEqual([candidate]);
  });

  // account_health and conversion_tracking: same require-evidence pattern,
  // covering the two remaining gated categories not exercised above.
  it("blocks account_health with no google_ads:*/api_error:* draft, allows it when one exists", () => {
    const candidate = draft({ category: "account_health", dedupeKey: "claude:account_health:Investigate account status" });

    expect(filterAiFindingDrafts([candidate], [])).toEqual([]);
    expect(
      filterAiFindingDrafts([candidate], [draft({ category: "account_health", dedupeKey: "api_error:google_ads_account:678-018-7978" })]),
    ).toHaveLength(1);
  });

  it("blocks conversion_tracking with no ga4_event_stopped:*/google_ads:* draft, allows it when one exists", () => {
    const candidate = draft({ category: "conversion_tracking", dedupeKey: "claude:conversion_tracking:Verify tracking setup" });

    expect(filterAiFindingDrafts([candidate], [])).toEqual([]);
    expect(
      filterAiFindingDrafts(
        [candidate],
        [draft({ category: "conversion_tracking", dedupeKey: "ga4_event_stopped:524948086:generate_lead" })],
      ),
    ).toHaveLength(1);
  });
});
