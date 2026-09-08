import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

// ./service mocked wholesale, keyed by function — this file tests
// router.ts's own wiring (authorization + which tenantId reaches the
// service), not marketing/service.ts's query logic, which already has its
// own direct tenant-isolation tests in service.test.ts. Same boundary-mock
// strategy as ai-analyst.ts's tests elsewhere in this package.
const serviceMock = vi.hoisted(() => ({
  listUnlinkedLeads: vi.fn(),
  linkLeadToClient: vi.fn(),
}));
vi.mock("./service", () => serviceMock);

const { marketingRouter } = await import("./router");

function callerWithSession(role: "admin" | "dispatcher", tenantId = "tenant-1") {
  return marketingRouter.createCaller({
    session: { user: { id: "user-1" }, profile: { id: "profile-1", tenantId, role, fullName: "Test User" } },
  } as never);
}

function callerWithNoSession() {
  return marketingRouter.createCaller({ session: null } as never);
}

const VALID_LINK_INPUT = { marketingLeadId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222" };

beforeEach(() => {
  serviceMock.listUnlinkedLeads.mockReset();
  serviceMock.linkLeadToClient.mockReset();
});

describe("marketingRouter.listUnlinkedLeads — authorization", () => {
  it("rejects an unauthenticated caller with UNAUTHORIZED, never reaching the service", async () => {
    await expect(callerWithNoSession().listUnlinkedLeads({ limit: 10 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(serviceMock.listUnlinkedLeads).not.toHaveBeenCalled();
  });

  it("rejects a dispatcher (non-admin) with FORBIDDEN, never reaching the service", async () => {
    await expect(callerWithSession("dispatcher").listUnlinkedLeads({ limit: 10 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(serviceMock.listUnlinkedLeads).not.toHaveBeenCalled();
  });

  it("allows an admin, passing exactly ctx.session.profile.tenantId to the service — the input schema has no tenantId field, so a caller can never supply a different one", async () => {
    serviceMock.listUnlinkedLeads.mockResolvedValue([]);

    await callerWithSession("admin", "tenant-real").listUnlinkedLeads({ limit: 10 });

    expect(serviceMock.listUnlinkedLeads).toHaveBeenCalledWith("tenant-real", { limit: 10 });
  });
});

describe("marketingRouter.linkLeadToClient — authorization", () => {
  it("rejects an unauthenticated caller with UNAUTHORIZED, never reaching the service", async () => {
    await expect(callerWithNoSession().linkLeadToClient(VALID_LINK_INPUT)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(serviceMock.linkLeadToClient).not.toHaveBeenCalled();
  });

  it("rejects a dispatcher (non-admin) with FORBIDDEN, never reaching the service", async () => {
    await expect(callerWithSession("dispatcher").linkLeadToClient(VALID_LINK_INPUT)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(serviceMock.linkLeadToClient).not.toHaveBeenCalled();
  });

  it("allows an admin, passing exactly ctx.session.profile.tenantId to the service — never a tenantId the caller could supply", async () => {
    serviceMock.linkLeadToClient.mockResolvedValue({ id: "lead-1", clientId: VALID_LINK_INPUT.clientId, status: "converted" });

    await callerWithSession("admin", "tenant-real").linkLeadToClient(VALID_LINK_INPUT);

    expect(serviceMock.linkLeadToClient).toHaveBeenCalledWith("tenant-real", VALID_LINK_INPUT);
  });
});

describe("marketingRouter.linkLeadToClient — cross-tenant / nonexistent ids", () => {
  it("throws NOT_FOUND (never silently succeeds) when the service reports no match — e.g. a lead or client id from a different tenant", async () => {
    serviceMock.linkLeadToClient.mockResolvedValue(null);

    const error = await callerWithSession("admin").linkLeadToClient(VALID_LINK_INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("NOT_FOUND");
  });

  it("returns the linked row as-is on a real match", async () => {
    const linked = { id: "lead-1", clientId: VALID_LINK_INPUT.clientId, status: "converted" };
    serviceMock.linkLeadToClient.mockResolvedValue(linked);

    const result = await callerWithSession("admin").linkLeadToClient(VALID_LINK_INPUT);

    expect(result).toEqual(linked);
  });
});

describe("marketingRouter.linkLeadToClient — input validation", () => {
  it("rejects a non-uuid marketingLeadId/clientId before ever reaching the service", async () => {
    // Both fields type as `string` (zod's .uuid() only adds runtime
    // validation, it doesn't narrow the TS type) — this is a real
    // runtime-only rejection, not a compile-time one.
    await expect(
      callerWithSession("admin").linkLeadToClient({ marketingLeadId: "not-a-uuid", clientId: "also-not-a-uuid" }),
    ).rejects.toThrow();
    expect(serviceMock.linkLeadToClient).not.toHaveBeenCalled();
  });
});
