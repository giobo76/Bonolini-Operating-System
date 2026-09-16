import { describe, expect, it, vi, beforeEach } from "vitest";

const socialPublishingMock = vi.hoisted(() => ({
  retryFacebookOnly: vi.fn(),
  getRealPostDataSnapshot: vi.fn(),
}));
vi.mock("../../social-publishing", () => socialPublishingMock);

const { createRetryFacebookOnlyTool, createPrepareSocialContentTool } = await import("./social-tools");
const { NoopImageGenerator } = await import("../image-generator");

beforeEach(() => {
  socialPublishingMock.retryFacebookOnly.mockReset();
  socialPublishingMock.getRealPostDataSnapshot.mockReset();
});

describe("social.retry_facebook_only tool — metadata (Policy Engine gate)", () => {
  it("declares itself irreversible and requiring approval — never auto-approvable", () => {
    const tool = createRetryFacebookOnlyTool();
    expect(tool.reversible).toBe(false);
    expect(tool.requiresApproval).toBe(true);
    expect(tool.riskLevel).toBe("requires_approval");
    expect(tool.category).toBe("content_publish");
  });
});

describe("social.retry_facebook_only tool — handler (thin wrapper, never re-implements publishing)", () => {
  it("delegates straight to retryFacebookOnly with the tenant from ctx and the postId from input", async () => {
    socialPublishingMock.retryFacebookOnly.mockResolvedValue({
      ok: true,
      alreadyPublished: false,
      facebookPostId: "page_123",
      error: null,
    });

    const tool = createRetryFacebookOnlyTool();
    const result = await tool.handler({ postId: "post-1" }, { tenantId: "tenant-1", callerId: "caller-1" });

    expect(socialPublishingMock.retryFacebookOnly).toHaveBeenCalledWith("tenant-1", "post-1");
    expect(result).toEqual({ ok: true, alreadyPublished: false, facebookPostId: "page_123", error: null });
  });

  it("throws (never silently succeeds) when the underlying post doesn't exist for this tenant", async () => {
    socialPublishingMock.retryFacebookOnly.mockResolvedValue(null);

    const tool = createRetryFacebookOnlyTool();
    await expect(tool.handler({ postId: "post-1" }, { tenantId: "tenant-1", callerId: "caller-1" })).rejects.toThrow(
      "not found",
    );
  });

  it("never calls, references, or otherwise touches Instagram in any way", async () => {
    socialPublishingMock.retryFacebookOnly.mockResolvedValue({
      ok: true,
      alreadyPublished: false,
      facebookPostId: "page_123",
      error: null,
    });

    const tool = createRetryFacebookOnlyTool();
    await tool.handler({ postId: "post-1" }, { tenantId: "tenant-1", callerId: "caller-1" });

    // The mocked social-publishing module only ever exposes
    // retryFacebookOnly/getRealPostDataSnapshot to this tool file (see the
    // vi.mock above) — there is no publishInstagramPost import anywhere in
    // social-tools.ts to call in the first place; this asserts the only
    // call made was the Facebook-only one.
    expect(socialPublishingMock.retryFacebookOnly).toHaveBeenCalledTimes(1);
  });

  it("verify() reports ok only when the underlying result reported ok", async () => {
    const tool = createRetryFacebookOnlyTool();
    expect(await tool.verify?.({ ok: true, alreadyPublished: false, facebookPostId: "p1", error: null }, { tenantId: "t", callerId: "c" })).toEqual({ ok: true, reason: undefined });
    expect(await tool.verify?.({ ok: false, alreadyPublished: false, facebookPostId: null, error: "Invalid token." }, { tenantId: "t", callerId: "c" })).toEqual({ ok: false, reason: "Invalid token." });
  });
});

describe("social.prepare_content tool — metadata (auto-approved, no side effects)", () => {
  it("declares itself low-risk, reversible, and not requiring approval", () => {
    const tool = createPrepareSocialContentTool(new NoopImageGenerator());
    expect(tool.riskLevel).toBe("low_risk");
    expect(tool.requiresApproval).toBe(false);
    expect(tool.reversible).toBe(true);
    expect(tool.category).toBe("content_generation");
  });
});

describe("social.prepare_content tool — handler (real data, safe fallback)", () => {
  it("derives a theme from real served routes and a safe fallback image result when no provider is configured", async () => {
    socialPublishingMock.getRealPostDataSnapshot.mockResolvedValue({
      servedRoutes: [{ pickup: "Milano", destination: "Lake Como" }],
      transferTypes: ["regional transfer"],
      serviceAreaPlaces: ["Milano", "Lake Como"],
      windowDays: 90,
    });

    const tool = createPrepareSocialContentTool(new NoopImageGenerator());
    const result = await tool.handler({}, { tenantId: "tenant-1", callerId: "caller-1" });

    expect(result.servedRoutesCount).toBe(1);
    expect(result.themes).toEqual(["Milano -> Lake Como"]);
    expect(result.image.ok).toBe(false);
    expect(result.image.provider).toBe("noop");
    expect(result.image.brief).toContain("Lake Como");
  });

  it("returns an honest empty result when there are no real served routes — never invents a theme", async () => {
    socialPublishingMock.getRealPostDataSnapshot.mockResolvedValue({
      servedRoutes: [],
      transferTypes: [],
      serviceAreaPlaces: [],
      windowDays: 90,
    });

    const tool = createPrepareSocialContentTool(new NoopImageGenerator());
    const result = await tool.handler({}, { tenantId: "tenant-1", callerId: "caller-1" });

    expect(result.servedRoutesCount).toBe(0);
    expect(result.image).toEqual({ ok: false, theme: null, brief: null, url: null, provider: "none" });
  });

  it("never writes to social_posts or calls any publish function — only reads real data and returns a preparation result", async () => {
    socialPublishingMock.getRealPostDataSnapshot.mockResolvedValue({
      servedRoutes: [{ pickup: "Milano", destination: "Tirano" }],
      transferTypes: ["regional transfer"],
      serviceAreaPlaces: [],
      windowDays: 90,
    });

    const tool = createPrepareSocialContentTool(new NoopImageGenerator());
    await tool.handler({}, { tenantId: "tenant-1", callerId: "caller-1" });

    expect(socialPublishingMock.retryFacebookOnly).not.toHaveBeenCalled();
  });
});
