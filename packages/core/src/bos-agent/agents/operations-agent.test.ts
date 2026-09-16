import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const messagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: (...args: unknown[]) => messagesCreate(...args) };
  },
}));

const marketingMock = vi.hoisted(() => ({ getTransferRequestFunnel: vi.fn() }));
vi.mock("../../marketing", () => marketingMock);

const transferRequestsMock = vi.hoisted(() => ({ listPendingApprovalTransferRequests: vi.fn() }));
vi.mock("../../transfer-requests", () => transferRequestsMock);

const { operationsAgent } = await import("./operations-agent");

function toolUseResponse(input: Record<string, unknown>) {
  return { content: [{ type: "tool_use", id: "tu_1", name: "report_operations_assessment", input }] };
}

const REQUEST_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  messagesCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
  transferRequestsMock.listPendingApprovalTransferRequests.mockResolvedValue([
    { id: REQUEST_ID, status: "pending_admin_approval", calculatedAmountCents: 5000, pickup: "Milano", destination: "Tirano", requestedDate: "2026-09-20", updatedAt: new Date() },
  ]);
  marketingMock.getTransferRequestFunnel.mockResolvedValue({
    requestsReceived: 1, requestsInProgress: 0, requestsReadyForPricing: 0, requestsPendingApproval: 1, requestsConvertedToQuote: 0, requestsCancelledOrExpired: 0, total: 1,
  });
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("operationsAgent — metadata", () => {
  it("declares the operations category", () => {
    expect(operationsAgent.metadata.category).toBe("operations");
  });
});

describe("operationsAgent — handler", () => {
  it("reads real pending requests and funnel data as its perception, never invents a request", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ summary: "One request pending.", followUpsNeeded: [], recommendations: [] }));

    const output = await operationsAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { perception: { pendingRequests: unknown[] } };

    expect(transferRequestsMock.listPendingApprovalTransferRequests).toHaveBeenCalledWith("tenant-1");
    expect(result.perception.pendingRequests).toHaveLength(1);
  });

  it("never sets a proposedAction — this agent never accepts/rejects/re-prices a request itself", async () => {
    messagesCreate.mockResolvedValue(
      toolUseResponse({
        summary: "One request pending.",
        followUpsNeeded: ["Call the client back"],
        recommendations: [{ transferRequestId: REQUEST_ID, suggestion: "accept", reasoning: "price looks fine" }],
      }),
    );

    const output = await operationsAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { proposedAction?: unknown; decision: { recommendations: unknown[] } };

    expect(result.proposedAction).toBeUndefined();
    expect(result.decision.recommendations).toHaveLength(1);
  });

  it("drops a recommendation naming a transferRequestId this run never actually saw — never trusts Claude's ids alone", async () => {
    messagesCreate.mockResolvedValue(
      toolUseResponse({
        summary: "...",
        followUpsNeeded: [],
        recommendations: [{ transferRequestId: "99999999-9999-9999-9999-999999999999", suggestion: "accept", reasoning: "invented" }],
      }),
    );

    const output = await operationsAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { decision: { recommendations: unknown[] } };

    expect(result.decision.recommendations).toHaveLength(0);
  });

  it("fails soft without calling Claude when ANTHROPIC_API_KEY is unset, and still sets no proposedAction", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const output = await operationsAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { proposedAction?: unknown };

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(result.proposedAction).toBeUndefined();
  });
});
