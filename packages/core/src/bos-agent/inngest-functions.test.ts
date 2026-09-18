import { describe, expect, it, vi, beforeEach } from "vitest";

// inngest.createFunction is mocked to capture its (config, trigger, handler)
// arguments directly, rather than standing up a real Inngest test harness —
// this lets each listener's handler be invoked in isolation with a fake
// {event, step}, exactly the way a real Inngest delivery would call it,
// without needing the actual Inngest runtime. No other module in this repo
// tests an Inngest *receiver* function today (only emitDomainEvent, the
// emitter side); this establishes that pattern.
const inngestMock = vi.hoisted(() => ({
  createFunction: vi.fn((config: unknown, trigger: unknown, handler: unknown) => ({ config, trigger, handler })),
}));
vi.mock("@bos/jobs", () => ({ inngest: inngestMock }));

const dbMock = vi.hoisted(() => ({ getDb: vi.fn(), tenants: {} }));
vi.mock("@bos/db", () => dbMock);

const orchestratorMock = vi.hoisted(() => ({ runAgentCycle: vi.fn() }));
vi.mock("./orchestrator", () => orchestratorMock);

// The real InngestFunction type (what these exports are declared as, since
// inngest-functions.ts imports the real @bos/jobs types) exposes neither
// `.trigger` nor `.handler` publicly — only what our mocked createFunction
// above actually returns at runtime, in this test environment, has that
// shape. This cast describes that runtime-only shape; it is not a general
// escape hatch and is scoped to this one test file.
interface MockedInngestFunction {
  trigger: { event: string } | { cron: string };
  handler: (args: {
    event: { data: Record<string, unknown> };
    step: { run: (name: string, fn: () => unknown) => unknown };
  }) => unknown;
}

const inngestFunctionsModule = (await import("./inngest-functions")) as unknown as {
  bosAgentOnBookingConfirmed: MockedInngestFunction;
  bosAgentOnBookingCompleted: MockedInngestFunction;
  bosAgentInngestFunctions: unknown[];
};
const { bosAgentOnBookingConfirmed, bosAgentOnBookingCompleted, bosAgentInngestFunctions } = inngestFunctionsModule;

// Mimics Inngest's own step.run(name, fn) closely enough for these tests:
// runs fn immediately and returns its result, so the assertions below see
// the exact call runAgentCycle receives.
function fakeStep() {
  return { run: (_name: string, fn: () => unknown) => fn() };
}

beforeEach(() => {
  orchestratorMock.runAgentCycle.mockReset();
  orchestratorMock.runAgentCycle.mockResolvedValue({ runId: "run-1", correlationId: "corr-1", status: "success" });
});

describe("bosAgentOnBookingConfirmed", () => {
  it("is registered on the exact event name booking.confirmed", () => {
    expect(bosAgentOnBookingConfirmed.trigger).toEqual({ event: "booking.confirmed" });
  });

  it("reaches the BOS Agent: calls runAgentCycle with the operations agent, trigger 'event', and the real tenantId/bookingId from the event", async () => {
    await bosAgentOnBookingConfirmed.handler({
      event: { data: { tenantId: "tenant-1", bookingId: "booking-42" } },
      step: fakeStep(),
    });

    expect(orchestratorMock.runAgentCycle).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      callerId: "system",
      agentName: "operations",
      trigger: "event",
      eventType: "booking.confirmed",
      correlationId: "booking-42",
      payload: { bookingId: "booking-42" },
    });
  });

  it("uses the bookingId as the correlationId, keyed off the real event payload, never a random/generated one", async () => {
    await bosAgentOnBookingConfirmed.handler({
      event: { data: { tenantId: "tenant-1", bookingId: "booking-abc" } },
      step: fakeStep(),
    });

    const call = orchestratorMock.runAgentCycle.mock.calls[0]?.[0];
    expect(call.correlationId).toBe("booking-abc");
  });

  it("keeps tenant isolation — passes exactly the event's own tenantId, never a different one", async () => {
    await bosAgentOnBookingConfirmed.handler({
      event: { data: { tenantId: "tenant-xyz", bookingId: "booking-1" } },
      step: fakeStep(),
    });

    const call = orchestratorMock.runAgentCycle.mock.calls[0]?.[0];
    expect(call.tenantId).toBe("tenant-xyz");
  });
});

describe("bosAgentOnBookingCompleted", () => {
  it("is registered on the exact event name booking.completed", () => {
    expect(bosAgentOnBookingCompleted.trigger).toEqual({ event: "booking.completed" });
  });

  it("reaches the BOS Agent: calls runAgentCycle with the operations agent, trigger 'event', and the real tenantId/bookingId from the event", async () => {
    await bosAgentOnBookingCompleted.handler({
      event: { data: { tenantId: "tenant-2", bookingId: "booking-99" } },
      step: fakeStep(),
    });

    expect(orchestratorMock.runAgentCycle).toHaveBeenCalledWith({
      tenantId: "tenant-2",
      callerId: "system",
      agentName: "operations",
      trigger: "event",
      eventType: "booking.completed",
      correlationId: "booking-99",
      payload: { bookingId: "booking-99" },
    });
  });

  it("never proposes or executes anything itself — only forwards to runAgentCycle, exactly like the booking.confirmed listener", async () => {
    // The real safety guarantee lives in the Operations Agent itself
    // (purely advisory, never sets proposedAction — see
    // agents/operations-agent.ts) and in the Policy Engine downstream of
    // runAgentCycle, not in this listener. This test only pins that the
    // listener's own job is exactly "forward the event," nothing more —
    // it calls runAgentCycle exactly once, with no other side effect.
    await bosAgentOnBookingCompleted.handler({
      event: { data: { tenantId: "tenant-2", bookingId: "booking-99" } },
      step: fakeStep(),
    });

    expect(orchestratorMock.runAgentCycle).toHaveBeenCalledTimes(1);
  });
});

describe("bosAgentInngestFunctions", () => {
  it("registers both new booking listeners alongside the existing ones", () => {
    expect(bosAgentInngestFunctions).toContain(bosAgentOnBookingConfirmed);
    expect(bosAgentInngestFunctions).toContain(bosAgentOnBookingCompleted);
  });
});
