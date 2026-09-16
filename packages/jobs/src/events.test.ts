import { describe, expect, it, vi } from "vitest";
import { emitDomainEvent } from "./events";

describe("emitDomainEvent", () => {
  it("sends a valid event with the exact name and data", async () => {
    const send = vi.fn().mockResolvedValue(undefined);

    await emitDomainEvent({ send }, "social_post.published", {
      tenantId: "11111111-1111-1111-1111-111111111111",
      postId: "22222222-2222-2222-2222-222222222222",
      weekStartDate: "2026-09-07",
      facebookPostId: "page_123",
    });

    expect(send).toHaveBeenCalledWith({
      name: "social_post.published",
      data: {
        tenantId: "11111111-1111-1111-1111-111111111111",
        postId: "22222222-2222-2222-2222-222222222222",
        weekStartDate: "2026-09-07",
        facebookPostId: "page_123",
      },
    });
  });

  it("never throws when the payload fails its own schema — logs and returns instead", async () => {
    const send = vi.fn();

    await expect(
      emitDomainEvent({ send }, "social_post.published", {
        // tenantId is not a uuid — should fail Zod validation.
        tenantId: "not-a-uuid",
        postId: "22222222-2222-2222-2222-222222222222",
        weekStartDate: "2026-09-07",
        facebookPostId: null,
      } as never),
    ).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
  });

  it("never throws when inngest.send itself rejects — the caller's own operation must never fail because of this", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(
      emitDomainEvent({ send }, "social_post.failed", {
        tenantId: "11111111-1111-1111-1111-111111111111",
        postId: "22222222-2222-2222-2222-222222222222",
        weekStartDate: "2026-09-07",
        reason: "Invalid OAuth access token.",
      }),
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
  });
});
