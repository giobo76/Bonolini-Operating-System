import { describe, expect, it, vi, beforeEach } from "vitest";

// Same boundary-mock strategy as bos-agent/router.test.ts and
// marketing/router.test.ts — this file tests router.ts's own wiring
// (authorization, which tenantId/profileId reaches each function), not
// the state machine itself, which already has its own direct tests in
// service.test.ts.
const serviceMock = vi.hoisted(() => ({
  createBusinessRule: vi.fn(),
  listBusinessRules: vi.fn(),
  getBusinessRule: vi.fn(),
  approveBusinessRuleVersion: vi.fn(),
  rejectBusinessRuleVersion: vi.fn(),
}));
vi.mock("./service", () => serviceMock);

const { businessRulesRouter } = await import("./router");

function callerWithSession(role: "admin" | "dispatcher", tenantId = "tenant-1", profileId = "profile-1") {
  return businessRulesRouter.createCaller({
    session: { user: { id: "user-1" }, profile: { id: profileId, tenantId, role, fullName: "Test User" } },
  } as never);
}

function callerWithNoSession() {
  return businessRulesRouter.createCaller({ session: null } as never);
}

const RULE_ID = "11111111-1111-1111-1111-111111111111";
const VERSION_ID = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  serviceMock.createBusinessRule.mockReset();
  serviceMock.listBusinessRules.mockReset().mockResolvedValue([]);
  serviceMock.getBusinessRule.mockReset();
  serviceMock.approveBusinessRuleVersion.mockReset();
  serviceMock.rejectBusinessRuleVersion.mockReset();
});

describe("businessRulesRouter — authorization (admin-only, dispatcher excluded)", () => {
  it("rejects an unauthenticated caller on every procedure", async () => {
    await expect(callerWithNoSession().list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(callerWithNoSession().get({ id: RULE_ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(callerWithNoSession().create({ key: "pricing.a", category: "pricing" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(callerWithNoSession().approve({ versionId: VERSION_ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(callerWithNoSession().reject({ versionId: VERSION_ID, reasoning: "no" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects a dispatcher with FORBIDDEN — business rules are founder-only, stricter than staffProcedure", async () => {
    await expect(callerWithSession("dispatcher").list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerWithSession("dispatcher").approve({ versionId: VERSION_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(callerWithSession("dispatcher").reject({ versionId: VERSION_ID, reasoning: "no" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("allows an admin through", async () => {
    await expect(callerWithSession("admin").list()).resolves.toEqual([]);
  });
});

describe("businessRulesRouter.get", () => {
  it("throws NOT_FOUND when the service finds nothing for this tenant", async () => {
    serviceMock.getBusinessRule.mockResolvedValue(null);
    await expect(callerWithSession("admin").get({ id: RULE_ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("passes exactly ctx.session.profile.tenantId, never a tenantId the caller could supply", async () => {
    serviceMock.getBusinessRule.mockResolvedValue({ id: RULE_ID, versions: [] });
    await callerWithSession("admin", "tenant-real").get({ id: RULE_ID });
    expect(serviceMock.getBusinessRule).toHaveBeenCalledWith("tenant-real", RULE_ID);
  });
});

describe("businessRulesRouter.create", () => {
  it("passes exactly ctx.session.profile.tenantId and the input through", async () => {
    serviceMock.createBusinessRule.mockResolvedValue({ id: RULE_ID });
    await callerWithSession("admin", "tenant-real").create({ key: "pricing.malpensa", category: "pricing" });
    expect(serviceMock.createBusinessRule).toHaveBeenCalledWith("tenant-real", { key: "pricing.malpensa", category: "pricing" });
  });
});

describe("businessRulesRouter.approve / reject", () => {
  it("approve passes tenantId, versionId, the caller's own profile id, and the optional reasoning", async () => {
    serviceMock.approveBusinessRuleVersion.mockResolvedValue({ id: VERSION_ID, status: "effective" });
    await callerWithSession("admin", "tenant-real", "profile-real").approve({ versionId: VERSION_ID, reasoning: "ok" });
    expect(serviceMock.approveBusinessRuleVersion).toHaveBeenCalledWith("tenant-real", VERSION_ID, "profile-real", "ok");
  });

  it("reject passes tenantId, versionId, the caller's own profile id, and the required reasoning", async () => {
    serviceMock.rejectBusinessRuleVersion.mockResolvedValue({ id: VERSION_ID, status: "rejected" });
    await callerWithSession("admin", "tenant-real", "profile-real").reject({ versionId: VERSION_ID, reasoning: "too risky" });
    expect(serviceMock.rejectBusinessRuleVersion).toHaveBeenCalledWith("tenant-real", VERSION_ID, "profile-real", "too risky");
  });

  it("rejects an empty reasoning at the schema layer before ever reaching the service", async () => {
    await expect(
      callerWithSession("admin").reject({ versionId: VERSION_ID, reasoning: "" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(serviceMock.rejectBusinessRuleVersion).not.toHaveBeenCalled();
  });

  it("maps a 'not found' service error to NOT_FOUND, and any other error to CONFLICT", async () => {
    serviceMock.approveBusinessRuleVersion.mockRejectedValue(new Error("approveBusinessRuleVersion: version x not found for this tenant"));
    await expect(callerWithSession("admin").approve({ versionId: VERSION_ID })).rejects.toMatchObject({ code: "NOT_FOUND" });

    serviceMock.approveBusinessRuleVersion.mockRejectedValue(new Error("approveBusinessRuleVersion: cannot approve a version with status 'rejected'"));
    await expect(callerWithSession("admin").approve({ versionId: VERSION_ID })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
