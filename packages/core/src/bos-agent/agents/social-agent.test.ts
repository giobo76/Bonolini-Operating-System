import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const messagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: (...args: unknown[]) => messagesCreate(...args) };
  },
}));

const socialPublishingMock = vi.hoisted(() => ({ listSocialPosts: vi.fn() }));
vi.mock("../../social-publishing", () => socialPublishingMock);

const { socialAgent } = await import("./social-agent");

function toolUseResponse(input: Record<string, unknown>) {
  return { content: [{ type: "tool_use", id: "tu_1", name: "report_social_decision", input }] };
}

const FAILED_POST_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  messagesCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
  socialPublishingMock.listSocialPosts.mockResolvedValue([
    { id: FAILED_POST_ID, weekStartDate: "2026-09-07", status: "failed", content: "some real content", metaError: "Invalid OAuth access token." },
  ]);
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("socialAgent — metadata", () => {
  it("declares the social category", () => {
    expect(socialAgent.metadata.category).toBe("social");
  });
});

describe("socialAgent — proposes retry_facebook only for a real, valid candidate", () => {
  it("proposes social.retry_facebook_only when Claude recommends retrying a post this run actually saw as failed-with-content", async () => {
    messagesCreate.mockResolvedValue(
      toolUseResponse({ recommendation: "retry_facebook", postId: FAILED_POST_ID, reasoning: "Facebook failed but content exists." }),
    );

    const output = await socialAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { proposedAction?: { toolName: string; input: { postId: string } } };

    expect(result.proposedAction).toEqual({ toolName: "social.retry_facebook_only", input: { postId: FAILED_POST_ID } });
  });

  it("never proposes a retry for a postId Claude invented that this run never actually saw", async () => {
    messagesCreate.mockResolvedValue(
      toolUseResponse({ recommendation: "retry_facebook", postId: "99999999-9999-9999-9999-999999999999", reasoning: "made up" }),
    );

    const output = await socialAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { proposedAction?: unknown };

    expect(result.proposedAction).toBeUndefined();
  });

  it("never proposes a retry for a post that already succeeded on Facebook, even if Claude recommends it", async () => {
    socialPublishingMock.listSocialPosts.mockResolvedValue([
      { id: FAILED_POST_ID, weekStartDate: "2026-09-07", status: "published", content: "some real content", metaError: null },
    ]);
    messagesCreate.mockResolvedValue(
      toolUseResponse({ recommendation: "retry_facebook", postId: FAILED_POST_ID, reasoning: "retry anyway" }),
    );

    const output = await socialAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { proposedAction?: unknown };

    expect(result.proposedAction).toBeUndefined();
  });

  it("proposes social.prepare_content when Claude recommends preparing content instead", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ recommendation: "prepare_content", reasoning: "nothing urgent, prep next week's post" }));

    const output = await socialAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { proposedAction?: { toolName: string } };

    expect(result.proposedAction).toEqual({ toolName: "social.prepare_content", input: {} });
  });

  it("proposes nothing when Claude recommends 'none'", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ recommendation: "none", reasoning: "nothing to do" }));

    const output = await socialAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { proposedAction?: unknown };

    expect(result.proposedAction).toBeUndefined();
  });

  it("never touches Instagram — reads no Instagram fields and never proposes an Instagram tool", async () => {
    messagesCreate.mockResolvedValue(
      toolUseResponse({ recommendation: "retry_facebook", postId: FAILED_POST_ID, reasoning: "retry" }),
    );

    const output = await socialAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { proposedAction?: { toolName: string } };

    expect(result.proposedAction?.toolName).not.toContain("instagram");
    expect(JSON.stringify(result)).not.toMatch(/instagram/i);
  });

  it("fails soft to 'none' without calling Claude when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const output = await socialAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { proposedAction?: unknown; decision: { recommendation: string } };

    expect(messagesCreate).not.toHaveBeenCalled();
    expect(result.decision.recommendation).toBe("none");
    expect(result.proposedAction).toBeUndefined();
  });
});

// V2 bug fix — same fix applied identically to operations-agent.ts, see
// that file's test suite for the fuller test matrix.
describe("socialAgent — schema validation outcome (never fabricated)", () => {
  it("sets validationFailed (never a fabricated recommendation:'none') when Claude's tool_use input fails decisionSchema", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ postId: FAILED_POST_ID })); // missing required 'recommendation'/'reasoning'

    const output = await socialAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { validationFailed?: { reason: string }; decision: Record<string, unknown>; proposedAction?: unknown };

    expect(result.validationFailed?.reason).toContain("schema validation");
    expect(result.decision).toEqual({});
    expect(result.proposedAction).toBeUndefined();
  });

  it("a genuinely valid recommendation:'none' is a real success, not a validation failure", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ recommendation: "none", reasoning: "nothing to do" }));

    const output = await socialAgent.handler({ tenantId: "tenant-1", payload: {}, callerId: "system" });
    const result = output.result as { validationFailed?: unknown };

    expect(result.validationFailed).toBeUndefined();
  });
});
