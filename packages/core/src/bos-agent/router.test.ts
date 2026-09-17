import { describe, expect, it, vi, beforeEach } from "vitest";

// Same boundary-mock strategy as marketing/router.test.ts — this file
// tests router.ts's own wiring (authorization, which tenantId reaches
// each function), not the underlying modules' own logic, which already
// have their own direct tests (audit.test.ts, approvals.test.ts,
// orchestrator.test.ts).
const auditMock = vi.hoisted(() => ({ listRuns: vi.fn(), getRun: vi.fn() }));
vi.mock("./audit", () => auditMock);

const approvalsMock = vi.hoisted(() => ({
  listPendingApprovals: vi.fn(),
  getApproval: vi.fn(),
  markRejected: vi.fn(),
}));
vi.mock("./approvals", () => approvalsMock);

const orchestratorMock = vi.hoisted(() => ({ runAgentCycle: vi.fn(), approveAndExecute: vi.fn() }));
vi.mock("./orchestrator", () => orchestratorMock);

const registryMock = vi.hoisted(() => ({ discoverAgents: vi.fn(), toolList: vi.fn() }));
vi.mock("./registry-instance", () => ({
  buildOrchestrator: () => ({ discoverAgents: registryMock.discoverAgents }),
  getToolRegistry: () => ({ list: registryMock.toolList }),
}));

const memoryMock = vi.hoisted(() => ({ memorySearch: vi.fn() }));
vi.mock("./memory", () => memoryMock);

const { bosAgentRouter } = await import("./router");

function callerWithSession(role: "admin" | "dispatcher", tenantId = "tenant-1") {
  return bosAgentRouter.createCaller({
    session: { user: { id: "user-1" }, profile: { id: "profile-1", tenantId, role, fullName: "Test User" } },
  } as never);
}

function callerWithNoSession() {
  return bosAgentRouter.createCaller({ session: null } as never);
}

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const APPROVAL_ID = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  auditMock.listRuns.mockReset();
  auditMock.getRun.mockReset();
  approvalsMock.listPendingApprovals.mockReset().mockResolvedValue([]);
  approvalsMock.getApproval.mockReset();
  approvalsMock.markRejected.mockReset();
  orchestratorMock.runAgentCycle.mockReset();
  orchestratorMock.approveAndExecute.mockReset();
  registryMock.discoverAgents.mockReset().mockResolvedValue([]);
  registryMock.toolList.mockReset().mockReturnValue([]);
  memoryMock.memorySearch.mockReset().mockResolvedValue([]);
});

describe("bosAgentRouter — authorization (admin-only, dispatcher excluded)", () => {
  it("rejects an unauthenticated caller on every procedure", async () => {
    await expect(callerWithNoSession().status()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(callerWithNoSession().listRuns({ limit: 10 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(callerWithNoSession().triggerNow({ agentName: "marketing" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a dispatcher with FORBIDDEN — this router is admin-only, stricter than staffProcedure", async () => {
    await expect(callerWithSession("dispatcher").status()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerWithSession("dispatcher").pendingApprovals()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows an admin through to status()", async () => {
    await expect(callerWithSession("admin").status()).resolves.toMatchObject({ pendingApprovalCount: 0 });
  });
});

describe("bosAgentRouter.listRuns / getRun", () => {
  it("passes exactly ctx.session.profile.tenantId to listRuns", async () => {
    auditMock.listRuns.mockResolvedValue([]);
    await callerWithSession("admin", "tenant-real").listRuns({ limit: 10 });
    expect(auditMock.listRuns).toHaveBeenCalledWith("tenant-real", 10);
  });

  it("throws NOT_FOUND when getRun finds nothing for this tenant", async () => {
    auditMock.getRun.mockResolvedValue(null);
    await expect(callerWithSession("admin").getRun({ id: RUN_ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns the run when it exists", async () => {
    auditMock.getRun.mockResolvedValue({ id: RUN_ID, status: "success" });
    await expect(callerWithSession("admin").getRun({ id: RUN_ID })).resolves.toMatchObject({ id: RUN_ID });
  });
});

describe("bosAgentRouter.approve", () => {
  it("throws NOT_FOUND when the approval doesn't exist for this tenant", async () => {
    approvalsMock.getApproval.mockResolvedValue(null);
    await expect(callerWithSession("admin").approve({ id: APPROVAL_ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(orchestratorMock.approveAndExecute).not.toHaveBeenCalled();
  });

  it("delegates to approveAndExecute (the single place owning approve+execute) with the caller's tenant/profile", async () => {
    approvalsMock.getApproval.mockResolvedValue({ id: APPROVAL_ID, agentRunId: "run-1", requestedAction: "social.retry_facebook_only", payload: { postId: "p1" } });
    orchestratorMock.approveAndExecute.mockResolvedValue({
      approval: { id: APPROVAL_ID, status: "executed" },
      actionResult: { ok: true },
      verification: { ok: true },
      alreadyExecuted: false,
    });

    const result = await callerWithSession("admin", "tenant-real").approve({ id: APPROVAL_ID });

    expect(orchestratorMock.approveAndExecute).toHaveBeenCalledWith("tenant-real", APPROVAL_ID, "profile-1");
    expect(result.actionResult).toEqual({ ok: true });
    expect(result.alreadyExecuted).toBe(false);
  });

  it("maps an approveAndExecute error (e.g. already rejected) to CONFLICT", async () => {
    approvalsMock.getApproval.mockResolvedValue({ id: APPROVAL_ID, status: "rejected" });
    orchestratorMock.approveAndExecute.mockRejectedValue(new Error("agent_approval is 'rejected', cannot be approved"));

    await expect(callerWithSession("admin").approve({ id: APPROVAL_ID })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("bosAgentRouter.memoryActivity", () => {
  it("passes exactly ctx.session.profile.tenantId and the requested namespace/limit to memorySearch", async () => {
    memoryMock.memorySearch.mockResolvedValue([{ kind: "decision", agentName: "social", summary: "ok", createdAt: "now" }]);

    const result = await callerWithSession("admin", "tenant-real").memoryActivity({ namespace: "social", limit: 5 });

    expect(memoryMock.memorySearch).toHaveBeenCalledWith("tenant-real", "social", { limit: 5 });
    expect(result).toHaveLength(1);
  });

  it("rejects an unknown namespace before ever reaching memorySearch", async () => {
    await expect(
      callerWithSession("admin").memoryActivity({ namespace: "not-a-real-namespace" as never, limit: 5 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(memoryMock.memorySearch).not.toHaveBeenCalled();
  });
});

describe("bosAgentRouter.reject", () => {
  it("throws NOT_FOUND when the approval doesn't exist for this tenant", async () => {
    approvalsMock.getApproval.mockResolvedValue(null);
    await expect(callerWithSession("admin").reject({ id: APPROVAL_ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects the approval, never touching any tool", async () => {
    approvalsMock.getApproval.mockResolvedValue({ id: APPROVAL_ID, status: "pending" });
    approvalsMock.markRejected.mockResolvedValue({ id: APPROVAL_ID, status: "rejected" });

    await expect(callerWithSession("admin", "tenant-real").reject({ id: APPROVAL_ID })).resolves.toMatchObject({ status: "rejected" });
    expect(approvalsMock.markRejected).toHaveBeenCalledWith("tenant-real", APPROVAL_ID);
    expect(orchestratorMock.approveAndExecute).not.toHaveBeenCalled();
  });
});

describe("bosAgentRouter.triggerNow", () => {
  it("passes exactly ctx.session.profile.tenantId/id and the requested agentName, with trigger 'manual'", async () => {
    orchestratorMock.runAgentCycle.mockResolvedValue({ runId: "run-1", status: "success" });

    await callerWithSession("admin", "tenant-real").triggerNow({ agentName: "social" });

    expect(orchestratorMock.runAgentCycle).toHaveBeenCalledWith({
      tenantId: "tenant-real",
      callerId: "profile-1",
      agentName: "social",
      trigger: "manual",
    });
  });

  it("rejects an invalid agentName before ever reaching the orchestrator", async () => {
    await expect(callerWithSession("admin").triggerNow({ agentName: "not-a-real-agent" } as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(orchestratorMock.runAgentCycle).not.toHaveBeenCalled();
  });
});
