import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

// Every stage before/after ACTION is mocked at the module boundary here,
// so this file tests orchestrator.ts's own sequencing/persistence logic in
// isolation — real agent handlers are covered by agents/*.test.ts, real
// tool wrappers by tools/*.test.ts, real policy rules by @bos/ai's own
// policy.test.ts, real context/memory by context-builder.test.ts/
// memory.test.ts. This is the one place all V2 stages are exercised
// together end-to-end.

const auditMock = vi.hoisted(() => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  completeRun: vi.fn(),
}));
vi.mock("./audit", () => auditMock);

const approvalsMock = vi.hoisted(() => ({
  createApproval: vi.fn(),
  getApproval: vi.fn(),
  markApproved: vi.fn(),
  markExecuted: vi.fn(),
  markExecutionFailed: vi.fn(),
  findApprovalByIdempotencyKey: vi.fn(),
}));
vi.mock("./approvals", () => approvalsMock);

const registryMock = vi.hoisted(() => ({
  invokeAgent: vi.fn(),
  toolGet: vi.fn(),
}));
vi.mock("./registry-instance", () => ({
  buildOrchestrator: () => ({ invokeAgent: registryMock.invokeAgent }),
  getToolRegistry: () => ({ get: registryMock.toolGet }),
}));

const contextBuilderMock = vi.hoisted(() => ({ buildContext: vi.fn() }));
vi.mock("./context-builder", () => contextBuilderMock);

const memoryMock = vi.hoisted(() => ({ memoryGet: vi.fn(), memorySet: vi.fn() }));
vi.mock("./memory", () => memoryMock);

const { runAgentCycle, approveAndExecute } = await import("./orchestrator");

function fakeTool(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: "test.tool",
    description: "test",
    inputSchema: z.any(),
    outputSchema: z.any(),
    riskLevel: "read_only",
    category: "read",
    requiresApproval: false,
    reversible: true,
    handler: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

beforeEach(() => {
  auditMock.createRun.mockReset().mockResolvedValue({ id: "run-1", status: "running" });
  auditMock.updateRun.mockReset().mockResolvedValue({ id: "run-1" });
  auditMock.completeRun.mockReset().mockImplementation(async (_tenantId, _runId, status, patch = {}) => ({
    id: "run-1",
    status,
    error: patch.error ?? null,
    ...patch,
  }));
  approvalsMock.createApproval.mockReset().mockResolvedValue({ id: "approval-1" });
  approvalsMock.getApproval.mockReset();
  approvalsMock.markApproved.mockReset();
  approvalsMock.markExecuted.mockReset().mockImplementation(async (_t, id) => ({ id, status: "executed" }));
  approvalsMock.markExecutionFailed.mockReset().mockImplementation(async (_t, id) => ({ id, status: "execution_failed" }));
  approvalsMock.findApprovalByIdempotencyKey.mockReset().mockResolvedValue(null);
  registryMock.invokeAgent.mockReset();
  registryMock.toolGet.mockReset();
  contextBuilderMock.buildContext.mockReset().mockResolvedValue({ entities: {}, memory: [], memoryNamespace: "social" });
  memoryMock.memoryGet.mockReset();
  memoryMock.memorySet.mockReset().mockResolvedValue(undefined);
});

describe("runAgentCycle — correlation id", () => {
  it("generates a correlation id automatically when none is given", async () => {
    registryMock.invokeAgent.mockResolvedValue({ result: { perception: {}, decision: {} } });

    const result = await runAgentCycle({ tenantId: "tenant-1", callerId: "system", agentName: "marketing", trigger: "manual" });

    expect(result.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("threads a caller-supplied correlation id through to createRun and the result", async () => {
    registryMock.invokeAgent.mockResolvedValue({ result: { perception: {}, decision: {} } });

    const result = await runAgentCycle({
      tenantId: "tenant-1",
      callerId: "system",
      agentName: "operations",
      trigger: "event",
      correlationId: "transfer-request-xyz",
    });

    expect(result.correlationId).toBe("transfer-request-xyz");
    expect(auditMock.createRun).toHaveBeenCalledWith(expect.objectContaining({ correlationId: "transfer-request-xyz" }));
  });
});

describe("runAgentCycle — advisory-only (no proposedAction)", () => {
  it("completes as success without ever consulting the Policy Engine or any tool", async () => {
    registryMock.invokeAgent.mockResolvedValue({ result: { perception: { a: 1 }, decision: { summary: "ok" } } });

    const result = await runAgentCycle({ tenantId: "tenant-1", callerId: "system", agentName: "marketing", trigger: "manual" });

    expect(result.status).toBe("success");
    expect(result.actionResult).toBeNull();
    expect(registryMock.toolGet).not.toHaveBeenCalled();
    expect(auditMock.completeRun).toHaveBeenCalledWith("tenant-1", "run-1", "success");
  });

  it("still applies any memoryWrites the agent's decision asked for", async () => {
    registryMock.invokeAgent.mockResolvedValue({
      result: {
        perception: {},
        decision: { summary: "ok" },
        memoryWrites: [{ key: "last-assessment", kind: "decision", summary: "all good" }],
      },
    });

    await runAgentCycle({ tenantId: "tenant-1", callerId: "system", agentName: "marketing", trigger: "manual" });

    expect(memoryMock.memorySet).toHaveBeenCalledWith(
      "tenant-1",
      "marketing",
      "last-assessment",
      expect.objectContaining({ kind: "decision", summary: "all good", agentName: "marketing" }),
    );
  });
});

describe("runAgentCycle — unknown tool", () => {
  it("fails the run when the agent proposes a tool that isn't registered", async () => {
    registryMock.invokeAgent.mockResolvedValue({
      result: { perception: {}, decision: {}, proposedAction: { toolName: "nonexistent.tool", input: {} } },
    });
    registryMock.toolGet.mockReturnValue(undefined);

    const result = await runAgentCycle({ tenantId: "tenant-1", callerId: "system", agentName: "social", trigger: "manual" });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("unknown tool");
  });
});

describe("runAgentCycle — Policy Engine deny-list", () => {
  it("denies a categorically-forbidden action, never calling the tool's handler, even if the tool itself claims low risk", async () => {
    const handler = vi.fn();
    registryMock.invokeAgent.mockResolvedValue({
      result: { perception: {}, decision: {}, proposedAction: { toolName: "danger.tool", input: {} } },
    });
    registryMock.toolGet.mockReturnValue(
      fakeTool({ name: "danger.tool", category: "secret_change", riskLevel: "read_only", requiresApproval: false, reversible: true, handler }),
    );

    const result = await runAgentCycle({ tenantId: "tenant-1", callerId: "system", agentName: "operations", trigger: "manual" });

    expect(result.status).toBe("denied");
    expect(handler).not.toHaveBeenCalled();
    expect(approvalsMock.createApproval).not.toHaveBeenCalled();
  });

  it("denies when the calling agent isn't in the tool's allowedAgents — no agent can bypass this by proposing another agent's tool", async () => {
    const handler = vi.fn();
    registryMock.invokeAgent.mockResolvedValue({
      result: { perception: {}, decision: {}, proposedAction: { toolName: "social.retry_facebook_only", input: {} } },
    });
    registryMock.toolGet.mockReturnValue(
      fakeTool({ name: "social.retry_facebook_only", allowedAgents: ["social"], handler }),
    );

    const result = await runAgentCycle({ tenantId: "tenant-1", callerId: "system", agentName: "marketing", trigger: "manual" });

    expect(result.status).toBe("denied");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("runAgentCycle — requires approval", () => {
  it("creates a pending approval and never calls the tool's handler yet", async () => {
    const handler = vi.fn();
    registryMock.invokeAgent.mockResolvedValue({
      result: { perception: {}, decision: {}, proposedAction: { toolName: "risky.tool", input: { postId: "p1" } } },
    });
    registryMock.toolGet.mockReturnValue(
      fakeTool({ name: "risky.tool", category: "content_publish", riskLevel: "requires_approval", requiresApproval: true, reversible: false, handler }),
    );

    const result = await runAgentCycle({ tenantId: "tenant-1", callerId: "system", agentName: "social", trigger: "manual" });

    expect(result.status).toBe("pending_approval");
    expect(handler).not.toHaveBeenCalled();
    expect(approvalsMock.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", agentRunId: "run-1", requestedAction: "risky.tool", payload: { postId: "p1" } }),
    );
  });

  it("skips creating a duplicate approval when an identical action (same idempotency key) is already pending/decided", async () => {
    const handler = vi.fn();
    registryMock.invokeAgent.mockResolvedValue({
      result: { perception: {}, decision: {}, proposedAction: { toolName: "risky.tool", input: { postId: "p1" } } },
    });
    registryMock.toolGet.mockReturnValue(
      fakeTool({
        name: "risky.tool",
        requiresApproval: true,
        reversible: false,
        getIdempotencyKey: (input: { postId: string }) => input.postId,
        handler,
      }),
    );
    approvalsMock.findApprovalByIdempotencyKey.mockResolvedValue({ id: "existing-approval", status: "pending" });

    const result = await runAgentCycle({ tenantId: "tenant-1", callerId: "system", agentName: "social", trigger: "manual" });

    expect(result.status).toBe("pending_approval");
    expect(approvalsMock.createApproval).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT treat an already-decided approval (e.g. executed) sharing the same idempotency key as a duplicate — a resolved decision point never blocks a fresh proposal", async () => {
    const handler = vi.fn();
    registryMock.invokeAgent.mockResolvedValue({
      result: { perception: {}, decision: {}, proposedAction: { toolName: "risky.tool", input: { postId: "p1" } } },
    });
    registryMock.toolGet.mockReturnValue(
      fakeTool({
        name: "risky.tool",
        requiresApproval: true,
        reversible: false,
        getIdempotencyKey: (input: { postId: string }) => input.postId,
        handler,
      }),
    );
    approvalsMock.findApprovalByIdempotencyKey.mockResolvedValue({ id: "old-approval", status: "executed" });

    const result = await runAgentCycle({ tenantId: "tenant-1", callerId: "system", agentName: "social", trigger: "manual" });

    expect(result.status).toBe("pending_approval");
    expect(approvalsMock.createApproval).toHaveBeenCalled();
  });
});

describe("runAgentCycle — auto-approved action", () => {
  it("executes the tool, verifies, and completes as success for a read-only/reversible action", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, value: 42 });
    registryMock.invokeAgent.mockResolvedValue({
      result: { perception: {}, decision: {}, proposedAction: { toolName: "safe.tool", input: {} } },
    });
    registryMock.toolGet.mockReturnValue(fakeTool({ name: "safe.tool", handler }));

    const result = await runAgentCycle({ tenantId: "tenant-1", callerId: "system", agentName: "social", trigger: "manual" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("success");
    expect(result.actionResult).toEqual({ ok: true, value: 42 });
    expect(approvalsMock.createApproval).not.toHaveBeenCalled();
  });

  it("uses the tool's own verify() and marks the run failed when verification reports not ok", async () => {
    const verify = vi.fn().mockResolvedValue({ ok: false, reason: "Graph API rejected it." });
    registryMock.invokeAgent.mockResolvedValue({
      result: { perception: {}, decision: {}, proposedAction: { toolName: "safe.tool", input: {} } },
    });
    registryMock.toolGet.mockReturnValue(fakeTool({ name: "safe.tool", verify }));

    const result = await runAgentCycle({ tenantId: "tenant-1", callerId: "system", agentName: "social", trigger: "manual" });

    expect(verify).toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Graph API rejected it.");
  });
});

describe("runAgentCycle — unexpected error", () => {
  it("marks the run failed and rethrows, never silently swallowing the error", async () => {
    registryMock.invokeAgent.mockRejectedValue(new Error("agent exploded"));

    await expect(
      runAgentCycle({ tenantId: "tenant-1", callerId: "system", agentName: "marketing", trigger: "manual" }),
    ).rejects.toThrow("agent exploded");

    expect(auditMock.completeRun).toHaveBeenCalledWith("tenant-1", "run-1", "failed", { error: "agent exploded" });
  });
});

describe("approveAndExecute", () => {
  it("runs the exact tool named on the approval with its stored payload, marks it executed, then completes the run", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, postId: "page_999" });
    approvalsMock.getApproval.mockResolvedValue({
      id: "approval-1",
      status: "pending",
      agentRunId: "run-1",
      requestedAction: "social.retry_facebook_only",
      payload: { postId: "post-1" },
      correlationId: null,
    });
    approvalsMock.markApproved.mockResolvedValue({
      id: "approval-1",
      status: "approved",
      agentRunId: "run-1",
      requestedAction: "social.retry_facebook_only",
      payload: { postId: "post-1" },
      correlationId: null,
    });
    registryMock.toolGet.mockReturnValue(fakeTool({ name: "social.retry_facebook_only", handler }));

    const result = await approveAndExecute("tenant-1", "approval-1", "admin-1");

    expect(handler).toHaveBeenCalledWith({ postId: "post-1" }, { tenantId: "tenant-1", callerId: "admin-1" });
    expect(result.actionResult).toEqual({ ok: true, postId: "page_999" });
    expect(result.alreadyExecuted).toBe(false);
    expect(approvalsMock.markExecuted).toHaveBeenCalledWith("tenant-1", "approval-1");
    expect(auditMock.completeRun).toHaveBeenCalledWith("tenant-1", "run-1", "success", expect.objectContaining({ action: result.actionResult }));
  });

  it("is idempotent — approving/executing an already-executed approval never re-runs the tool", async () => {
    const handler = vi.fn();
    approvalsMock.getApproval.mockResolvedValue({ id: "approval-1", status: "executed" });
    registryMock.toolGet.mockReturnValue(fakeTool({ handler }));

    const result = await approveAndExecute("tenant-1", "approval-1", "admin-1");

    expect(result.alreadyExecuted).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(approvalsMock.markApproved).not.toHaveBeenCalled();
  });

  it("is idempotent — an already-execution_failed approval is also never re-run automatically", async () => {
    const handler = vi.fn();
    approvalsMock.getApproval.mockResolvedValue({ id: "approval-1", status: "execution_failed" });
    registryMock.toolGet.mockReturnValue(fakeTool({ handler }));

    const result = await approveAndExecute("tenant-1", "approval-1", "admin-1");

    expect(result.alreadyExecuted).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("throws for an already-rejected approval — cannot be approved after the fact", async () => {
    approvalsMock.getApproval.mockResolvedValue({ id: "approval-1", status: "rejected" });

    await expect(approveAndExecute("tenant-1", "approval-1", "admin-1")).rejects.toThrow("rejected");
  });

  it("throws for an unknown approval id", async () => {
    approvalsMock.getApproval.mockResolvedValue(null);

    await expect(approveAndExecute("tenant-1", "nonexistent", "admin-1")).rejects.toThrow("no agent_approval found");
  });

  it("marks execution_failed (never executed) when the tool's handler throws", async () => {
    approvalsMock.getApproval.mockResolvedValue({ id: "approval-1", status: "pending", agentRunId: "run-1", requestedAction: "t", payload: {} });
    approvalsMock.markApproved.mockResolvedValue({ id: "approval-1", status: "approved", agentRunId: "run-1", requestedAction: "t", payload: {} });
    registryMock.toolGet.mockReturnValue(fakeTool({ handler: vi.fn().mockRejectedValue(new Error("network down")) }));

    await expect(approveAndExecute("tenant-1", "approval-1", "admin-1")).rejects.toThrow("network down");
    expect(approvalsMock.markExecutionFailed).toHaveBeenCalledWith("tenant-1", "approval-1");
    expect(approvalsMock.markExecuted).not.toHaveBeenCalled();
  });
});
