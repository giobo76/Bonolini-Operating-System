import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

// Every stage before/after ACTION is mocked at the module boundary here,
// so this file tests orchestrator.ts's own sequencing/persistence logic in
// isolation — real agent handlers are covered by agents/*.test.ts, real
// tool wrappers by tools/*.test.ts, real policy rules by @bos/ai's own
// policy.test.ts. This is the one place all seven stages are exercised
// together end-to-end.

const auditMock = vi.hoisted(() => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  completeRun: vi.fn(),
}));
vi.mock("./audit", () => auditMock);

const approvalsMock = vi.hoisted(() => ({ createApproval: vi.fn() }));
vi.mock("./approvals", () => approvalsMock);

const registryMock = vi.hoisted(() => ({
  invokeAgent: vi.fn(),
  toolGet: vi.fn(),
}));
vi.mock("./registry-instance", () => ({
  buildOrchestrator: () => ({ invokeAgent: registryMock.invokeAgent }),
  getToolRegistry: () => ({ get: registryMock.toolGet }),
}));

const { runAgentCycle, executeApprovedAction } = await import("./orchestrator");

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
  registryMock.invokeAgent.mockReset();
  registryMock.toolGet.mockReset();
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

  it("defaults verification to ok when a tool declares no verify() at all", async () => {
    registryMock.invokeAgent.mockResolvedValue({
      result: { perception: {}, decision: {}, proposedAction: { toolName: "safe.tool", input: {} } },
    });
    registryMock.toolGet.mockReturnValue(fakeTool({ name: "safe.tool" }));

    const result = await runAgentCycle({ tenantId: "tenant-1", callerId: "system", agentName: "social", trigger: "manual" });

    expect(result.status).toBe("success");
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

describe("executeApprovedAction", () => {
  it("runs the exact tool named on the approval with its stored payload, then completes the run", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true, postId: "page_999" });
    registryMock.toolGet.mockReturnValue(fakeTool({ name: "social.retry_facebook_only", handler }));

    const { actionResult, verification } = await executeApprovedAction(
      "tenant-1",
      "run-1",
      "social.retry_facebook_only",
      { postId: "post-1" },
    );

    expect(handler).toHaveBeenCalledWith({ postId: "post-1" }, { tenantId: "tenant-1", callerId: "approval" });
    expect(actionResult).toEqual({ ok: true, postId: "page_999" });
    expect(verification.ok).toBe(true);
    expect(auditMock.completeRun).toHaveBeenCalledWith("tenant-1", "run-1", "success", expect.objectContaining({ action: actionResult }));
  });

  it("throws for an unknown tool name, never silently no-oping", async () => {
    registryMock.toolGet.mockReturnValue(undefined);

    await expect(executeApprovedAction("tenant-1", "run-1", "nonexistent.tool", {})).rejects.toThrow("unknown tool");
  });
});
