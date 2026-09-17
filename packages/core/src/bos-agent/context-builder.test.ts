import { describe, expect, it, vi, beforeEach } from "vitest";

const transferRequestsMock = vi.hoisted(() => ({ getTransferRequest: vi.fn() }));
vi.mock("../transfer-requests", () => transferRequestsMock);

const memoryMock = vi.hoisted(() => ({ memorySearch: vi.fn() }));
vi.mock("./memory", () => memoryMock);

const { buildContext } = await import("./context-builder");

beforeEach(() => {
  transferRequestsMock.getTransferRequest.mockReset();
  memoryMock.memorySearch.mockReset().mockResolvedValue([]);
});

describe("buildContext — entity resolution", () => {
  it("resolves the real transfer request when an operations run's payload carries a transferRequestId", async () => {
    transferRequestsMock.getTransferRequest.mockResolvedValue({ id: "req-1", status: "pending_admin_approval" });

    const context = await buildContext({
      tenantId: "tenant-1",
      callerId: "system",
      agentName: "operations",
      trigger: "event",
      payload: { transferRequestId: "req-1" },
    });

    expect(transferRequestsMock.getTransferRequest).toHaveBeenCalledWith("tenant-1", "req-1");
    expect(context.entities.transferRequest).toEqual({ id: "req-1", status: "pending_admin_approval" });
  });

  it("never invents an entity — records transferRequestNotFound rather than fabricating a row when none exists", async () => {
    transferRequestsMock.getTransferRequest.mockResolvedValue(null);

    const context = await buildContext({
      tenantId: "tenant-1",
      callerId: "system",
      agentName: "operations",
      trigger: "event",
      payload: { transferRequestId: "req-missing" },
    });

    expect(context.entities.transferRequest).toBeUndefined();
    expect(context.entities.transferRequestNotFound).toBe("req-missing");
  });

  it("does not attempt any entity lookup for a plain manual/cron trigger with no referenced entity", async () => {
    await buildContext({ tenantId: "tenant-1", callerId: "system", agentName: "marketing", trigger: "cron" });

    expect(transferRequestsMock.getTransferRequest).not.toHaveBeenCalled();
  });

  it("does not resolve a transferRequestId for a non-operations agent — only Operations Agent gets this entity", async () => {
    await buildContext({
      tenantId: "tenant-1",
      callerId: "system",
      agentName: "social",
      trigger: "event",
      payload: { transferRequestId: "req-1" },
    });

    expect(transferRequestsMock.getTransferRequest).not.toHaveBeenCalled();
  });
});

describe("buildContext — memory recall", () => {
  it("recalls from the agent's own namespace, bounded, when no specific entity is in play", async () => {
    await buildContext({ tenantId: "tenant-1", callerId: "system", agentName: "marketing", trigger: "cron" });

    expect(memoryMock.memorySearch).toHaveBeenCalledWith("tenant-1", "marketing", { limit: 5 });
  });

  it("narrows recall to records matching the specific entity's id when one is known", async () => {
    transferRequestsMock.getTransferRequest.mockResolvedValue({ id: "req-1" });

    await buildContext({
      tenantId: "tenant-1",
      callerId: "system",
      agentName: "operations",
      trigger: "event",
      payload: { transferRequestId: "req-1" },
    });

    expect(memoryMock.memorySearch).toHaveBeenCalledWith("tenant-1", "operations", { limit: 5, filter: expect.any(Function) });
    const filterFn = memoryMock.memorySearch.mock.calls[0]![2].filter;
    expect(filterFn({ data: { transferRequestId: "req-1" } })).toBe(true);
    expect(filterFn({ data: { transferRequestId: "some-other-request" } })).toBe(false);
  });

  it("reports the exact namespace queried so the orchestrator can audit it truthfully", async () => {
    const context = await buildContext({ tenantId: "tenant-1", callerId: "system", agentName: "social", trigger: "manual" });
    expect(context.memoryNamespace).toBe("social");
  });
});
