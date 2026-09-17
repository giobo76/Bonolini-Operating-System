import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Same @anthropic-ai/sdk mocking convention as whatsapp/parser.test.ts —
// never a real network call in this suite.
const messagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: (...args: unknown[]) => messagesCreate(...args) };
  },
}));

const marketingMock = vi.hoisted(() => ({
  getRealConversionSummary: vi.fn(),
  getFunnelSummary: vi.fn(),
  getConversionRates: vi.fn(),
}));
vi.mock("../../marketing", () => marketingMock);

const { marketingAgent } = await import("./marketing-agent");

function toolUseResponse(input: Record<string, unknown>) {
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "report_marketing_assessment", input }] };
}

function truncatedResponse(partialInput: Record<string, unknown>) {
  return { stop_reason: "max_tokens", content: [{ type: "tool_use", id: "tu_1", name: "report_marketing_assessment", input: partialInput }] };
}

beforeEach(() => {
  messagesCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
  marketingMock.getRealConversionSummary.mockResolvedValue({ realConversions: 5, attributedConversions: 3, unattributedConversions: 2 });
  marketingMock.getFunnelSummary.mockResolvedValue({ bySource: [], overall: { source: "overall", leads: 0, quotes: 0, quotesAccepted: 0, bookingsConfirmed: 0, bookingsCompleted: 0, bookingsCancelled: 0 } });
  marketingMock.getConversionRates.mockResolvedValue({ quoteAcceptanceRate: null, depositConversionRate: null, bookingCompletionRate: null, returnCustomerRate: null });
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("marketingAgent — metadata", () => {
  it("declares the marketing category and capability", () => {
    expect(marketingAgent.metadata.category).toBe("marketing");
    expect(marketingAgent.metadata.capabilities).toContain("marketing");
  });
});

describe("marketingAgent — handler", () => {
  it("reads real conversion/funnel/rate data as its perception, never invents it", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ summary: "Looks healthy.", anomalies: [], recommendations: [] }));

    const output = await marketingAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { perception: Record<string, unknown> };

    expect(marketingMock.getRealConversionSummary).toHaveBeenCalledWith("tenant-1");
    expect(result.perception.realConversionSummary).toEqual({ realConversions: 5, attributedConversions: 3, unattributedConversions: 2 });
  });

  it("never sets a proposedAction — this agent is purely advisory in this version", async () => {
    messagesCreate.mockResolvedValue(
      toolUseResponse({
        summary: "Spend seems inefficient.",
        anomalies: [{ title: "CPA spike", description: "...", severity: "high" }],
        recommendations: [{ title: "Increase budget", description: "...", requiresApproval: true }],
      }),
    );

    const output = await marketingAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { proposedAction?: unknown; decision: { recommendations: unknown[] } };

    expect(result.proposedAction).toBeUndefined();
    expect(result.decision.recommendations).toHaveLength(1);
  });

  it("fails soft with a data-only summary, never calling Claude, when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const output = await marketingAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { decision: { summary: string } };

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(result.decision.summary).toContain("ANTHROPIC_API_KEY");
  });
});

// V2 bug fix — same fix applied identically to operations-agent.ts, see
// that file's test suite for the fuller test matrix; this pins the same
// contract here so Marketing never regresses to the pre-fix behavior
// either.
describe("marketingAgent — schema validation outcome (never fabricated)", () => {
  it("sets validationFailed (never a fabricated empty decision) when Claude's tool_use input fails decisionSchema", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ anomalies: [], recommendations: [] })); // missing required 'summary'

    const output = await marketingAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { validationFailed?: { reason: string }; decision: Record<string, unknown> };

    expect(result.validationFailed?.reason).toContain("schema validation");
    expect(result.decision).toEqual({});
  });

  it("a valid decision with empty anomalies/recommendations is a real success, not a validation failure", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ summary: "Nothing notable this run.", anomalies: [], recommendations: [] }));

    const output = await marketingAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { validationFailed?: unknown };

    expect(result.validationFailed).toBeUndefined();
  });
});

// Same latent defect as operations-agent.ts's real 2026-09 production
// bug — anomalies/recommendations are both required arrays here too, and
// Claude could just as easily omit one of them instead of sending [].
// Fixed identically (property descriptions + SYSTEM_PROMPT both spell out
// "always present, use [] if empty"); these tests pin the fixed contract.
describe("marketingAgent — output contract regression (2026-09 production bug family: omitted required array)", () => {
  it("a valid output with multiple anomalies and multiple recommendations passes through in full", async () => {
    messagesCreate.mockResolvedValue(
      toolUseResponse({
        summary: "Two anomalies and two recommendations this run.",
        anomalies: [
          { title: "CPA spike", description: "Cost per acquisition doubled week over week.", severity: "high" },
          { title: "Drop in leads", description: "Lead volume down from the usual range.", severity: "medium" },
        ],
        recommendations: [
          { title: "Increase budget", description: "The top campaign is under-spending its daily cap.", requiresApproval: true },
          { title: "Pause underperforming ad", description: "This ad has zero conversions in two weeks.", requiresApproval: true },
        ],
      }),
    );

    const output = await marketingAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { validationFailed?: unknown; decision: { anomalies: unknown[]; recommendations: unknown[] } };

    expect(result.validationFailed).toBeUndefined();
    expect(result.decision.anomalies).toHaveLength(2);
    expect(result.decision.recommendations).toHaveLength(2);
  });

  it("Claude omitting `recommendations` entirely (not even []) is a validation failure naming that field, never a fabricated empty decision", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ summary: "Looks healthy.", anomalies: [] }));

    const output = await marketingAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { validationFailed?: { reason: string }; decision: Record<string, unknown> };

    expect(result.validationFailed?.reason).toContain("recommendations");
    expect(result.decision).toEqual({});
  });
});

// ROOT CAUSE FIX (2026-09) — same mechanism as operations-agent.ts's real
// production failures: generation cut off by max_tokens, not a prompt
// problem. See that file's equivalent describe block for the full
// investigation writeup.
describe("marketingAgent — truncated response (stop_reason=max_tokens) never trusted", () => {
  it("a truncated response (stop_reason max_tokens, required fields missing) is caught deterministically, before decisionSchema ever runs", async () => {
    messagesCreate.mockResolvedValue(truncatedResponse({ anomalies: [] }));

    const output = await marketingAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { validationFailed?: { reason: string }; decision: Record<string, unknown> };

    expect(result.validationFailed?.reason).toContain("truncated");
    expect(result.validationFailed?.reason).toContain("max_tokens");
    expect(result.validationFailed?.reason).not.toContain("schema validation");
    expect(result.decision).toEqual({});
  });

  it("a normal, complete response (stop_reason tool_use) is never treated as truncated", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ summary: "Looks healthy.", anomalies: [], recommendations: [] }));

    const output = await marketingAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { validationFailed?: unknown };

    expect(result.validationFailed).toBeUndefined();
  });

  it("calls the Anthropic API with a larger max_tokens budget (4096) — verified on the actual payload sent to the client", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ summary: "ok", anomalies: [], recommendations: [] }));

    await marketingAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });

    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 4096 }));
  });
});

// DEFINITIVE ROOT CAUSE FIX (2026-09) — see operations-agent.ts's
// equivalent describe block for the full investigation writeup. Asserts
// on the actual object handed to the Anthropic client mock, not the
// internal DECISION_TOOL constant.
describe("marketingAgent — Anthropic payload contract (strict tool use)", () => {
  function sentTool() {
    const call = messagesCreate.mock.calls.at(-1)![0] as {
      tools: Array<{ name: string; strict?: boolean; input_schema: Record<string, unknown> }>;
      tool_choice: { type: string; name: string; disable_parallel_tool_use?: boolean };
    };
    return { tool: call.tools[0]!, toolChoice: call.tool_choice };
  }

  it("sends strict: true on the report_marketing_assessment tool", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ summary: "ok", anomalies: [], recommendations: [] }));

    await marketingAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });

    expect(sentTool().tool.strict).toBe(true);
  });

  it("sends additionalProperties: false at the top-level input_schema and at the nested anomalies/recommendations item schemas", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ summary: "ok", anomalies: [], recommendations: [] }));

    await marketingAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });

    const schema = sentTool().tool.input_schema as {
      additionalProperties: boolean;
      properties: {
        anomalies: { items: { additionalProperties: boolean } };
        recommendations: { items: { additionalProperties: boolean } };
      };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.anomalies.items.additionalProperties).toBe(false);
    expect(schema.properties.recommendations.items.additionalProperties).toBe(false);
  });

  it("keeps summary, anomalies, and recommendations in the top-level required list", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ summary: "ok", anomalies: [], recommendations: [] }));

    await marketingAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });

    const schema = sentTool().tool.input_schema as { required: string[] };
    expect(schema.required).toEqual(["summary", "anomalies", "recommendations"]);
  });

  it("sends disable_parallel_tool_use: true on tool_choice", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ summary: "ok", anomalies: [], recommendations: [] }));

    await marketingAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });

    expect(sentTool().toolChoice.disable_parallel_tool_use).toBe(true);
  });
});
