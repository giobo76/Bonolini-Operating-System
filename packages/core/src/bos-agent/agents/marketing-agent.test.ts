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
  return { content: [{ type: "tool_use", id: "tu_1", name: "report_marketing_assessment", input }] };
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
