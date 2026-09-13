import { describe, expect, it, vi, beforeEach } from "vitest";

// Four independent mock surfaces, one per concern this module deliberately
// keeps separate (per the founder's explicit instruction):
// 1. @bos/db — only social_posts (this module's own table).
// 2. ./content-source — real data gathering, mocked so tests control
//    exactly what "real data" is available without touching bookings.
// 3. ./content-generator — Claude call, mocked so no automated test in this
//    suite ever calls the real Anthropic API.
// 4. ./meta-client — Graph API call, mocked so no automated test in this
//    suite ever calls the real Facebook Graph API. This is the hard
//    guarantee behind requirement 7 ("no real publication during automated
//    tests").
const { fakeState } = vi.hoisted(() => ({
  fakeState: {
    posts: [] as Array<Record<string, unknown>>,
    nextId: 1,
  },
}));

vi.mock("@bos/db", () => ({
  socialPosts: { tenantId: "tenantId", weekStartDate: "weekStartDate" },
  getDb: () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            const exists = fakeState.posts.some(
              (p) => p.tenantId === values.tenantId && p.weekStartDate === values.weekStartDate,
            );
            if (exists) return [];
            const row = { id: `post-${fakeState.nextId++}`, status: "draft", ...values };
            fakeState.posts.push(row);
            return [row];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(fakeState.posts),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          const row = fakeState.posts[fakeState.posts.length - 1];
          if (row) Object.assign(row, values);
          return [];
        },
      }),
    }),
  }),
  assertOne: <T,>(rows: T[], context: string): T => {
    const row = rows[0];
    if (!row) throw new Error(`Expected exactly one row from ${context}, got none`);
    return row;
  },
}));

const contentSourceMock = vi.hoisted(() => ({
  getRealPostDataSnapshot: vi.fn(),
  hasEnoughDataForPost: vi.fn(),
}));
vi.mock("./content-source", () => contentSourceMock);

const contentGeneratorMock = vi.hoisted(() => ({ generatePostContent: vi.fn() }));
vi.mock("./content-generator", () => contentGeneratorMock);

const validatorMock = vi.hoisted(() => ({ validatePost: vi.fn(), validateInstagramCaptionLength: vi.fn() }));
vi.mock("./validator", () => validatorMock);

const metaClientMock = vi.hoisted(() => ({ publishTextPost: vi.fn(), publishInstagramPost: vi.fn() }));
vi.mock("./meta-client", () => metaClientMock);

const { runWeeklySocialPost, getWeekStartDateEuropeRome } = await import("./service");

const SNAPSHOT = {
  servedRoutes: [{ pickup: "Milano", destination: "Tirano" }],
  transferTypes: ["regional transfer"],
  serviceAreaPlaces: ["Milano", "Tirano"],
  windowDays: 90,
};

beforeEach(() => {
  fakeState.posts = [];
  fakeState.nextId = 1;
  contentSourceMock.getRealPostDataSnapshot.mockReset().mockResolvedValue(SNAPSHOT);
  contentSourceMock.hasEnoughDataForPost.mockReset().mockReturnValue(true);
  contentGeneratorMock.generatePostContent.mockReset().mockResolvedValue("A real, grounded post about our routes.");
  validatorMock.validatePost.mockReset().mockReturnValue({ valid: true, errors: [] });
  validatorMock.validateInstagramCaptionLength.mockReset().mockReturnValue(null);
  metaClientMock.publishTextPost.mockReset().mockResolvedValue({ ok: true, postId: "page_123" });
  metaClientMock.publishInstagramPost.mockReset().mockResolvedValue({ ok: true, mediaId: "ig_123" });
  delete process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  delete process.env.INSTAGRAM_POST_IMAGE_URL;
});

describe("getWeekStartDateEuropeRome", () => {
  it("returns the same Monday for a trigger instant that is itself a Monday 09:00 Europe/Rome", () => {
    // 2026-09-07 is a Monday.
    const monday = new Date("2026-09-07T07:00:00Z"); // 09:00 Europe/Rome (CEST, UTC+2)
    expect(getWeekStartDateEuropeRome(monday)).toBe("2026-09-07");
  });

  it("resolves a Sunday to the Monday that already passed, not the upcoming one", () => {
    const sunday = new Date("2026-09-13T10:00:00Z");
    expect(getWeekStartDateEuropeRome(sunday)).toBe("2026-09-07");
  });

  it("resolves a mid-week day to that same week's Monday", () => {
    const wednesday = new Date("2026-09-09T10:00:00Z");
    expect(getWeekStartDateEuropeRome(wednesday)).toBe("2026-09-07");
  });

  it("correctly crosses a month boundary", () => {
    // 2026-10-01 is a Thursday; that week's Monday is 2026-09-28.
    const thursday = new Date("2026-10-01T10:00:00Z");
    expect(getWeekStartDateEuropeRome(thursday)).toBe("2026-09-28");
  });
});

const MONDAY = new Date("2026-09-07T07:00:00Z");

describe("runWeeklySocialPost — idempotency", () => {
  it("publishes exactly once per tenant per week even if run twice", async () => {
    await runWeeklySocialPost("tenant-1", MONDAY);
    metaClientMock.publishTextPost.mockClear();
    contentGeneratorMock.generatePostContent.mockClear();

    const second = await runWeeklySocialPost("tenant-1", MONDAY);

    expect(second.status).toBe("published");
    expect(metaClientMock.publishTextPost).not.toHaveBeenCalled();
    expect(contentGeneratorMock.generatePostContent).not.toHaveBeenCalled();
    expect(fakeState.posts).toHaveLength(1);
  });

  it("does not skip a previously failed week — only 'draft' status falls through, not a terminal failure that a retry should not blindly repeat every time either", async () => {
    contentSourceMock.hasEnoughDataForPost.mockReturnValue(false);
    const first = await runWeeklySocialPost("tenant-1", MONDAY);
    expect(first.status).toBe("failed");

    // A second run the same week, still failed, does not attempt to publish
    // again — the row is no longer 'draft'.
    const second = await runWeeklySocialPost("tenant-1", MONDAY);
    expect(second.status).toBe("failed");
    expect(metaClientMock.publishTextPost).not.toHaveBeenCalled();
  });

  it("creates independent rows for different tenants in the same week", async () => {
    await runWeeklySocialPost("tenant-1", MONDAY);
    await runWeeklySocialPost("tenant-2", MONDAY);

    expect(fakeState.posts).toHaveLength(2);
  });
});

describe("runWeeklySocialPost — no real data", () => {
  it("marks the post failed and never calls Claude or Meta when there is no real data to ground it in", async () => {
    contentSourceMock.hasEnoughDataForPost.mockReturnValue(false);

    const result = await runWeeklySocialPost("tenant-1", MONDAY);

    expect(result.status).toBe("failed");
    expect(contentGeneratorMock.generatePostContent).not.toHaveBeenCalled();
    expect(metaClientMock.publishTextPost).not.toHaveBeenCalled();
  });
});

describe("runWeeklySocialPost — generation unavailable", () => {
  it("marks the post failed and never calls Meta when content generation returns null", async () => {
    contentGeneratorMock.generatePostContent.mockResolvedValue(null);

    const result = await runWeeklySocialPost("tenant-1", MONDAY);

    expect(result.status).toBe("failed");
    expect(metaClientMock.publishTextPost).not.toHaveBeenCalled();
  });
});

describe("runWeeklySocialPost — validation failure", () => {
  it("marks the post failed and never calls Meta when validation rejects the content", async () => {
    validatorMock.validatePost.mockReturnValue({ valid: false, errors: ["post has no recognizable call-to-action"] });

    const result = await runWeeklySocialPost("tenant-1", MONDAY);

    expect(result.status).toBe("failed");
    expect(result.metaError).toContain("post has no recognizable call-to-action");
    expect(metaClientMock.publishTextPost).not.toHaveBeenCalled();
  });
});

describe("runWeeklySocialPost — Graph API publish failure", () => {
  it("marks the post failed with the Graph API's own error, never invents a different one", async () => {
    metaClientMock.publishTextPost.mockResolvedValue({ ok: false, error: "Invalid OAuth access token." });

    const result = await runWeeklySocialPost("tenant-1", MONDAY);

    expect(result.status).toBe("failed");
    expect(result.metaError).toBe("Invalid OAuth access token.");
  });
});

describe("runWeeklySocialPost — success", () => {
  it("publishes and records the real Meta post id", async () => {
    const result = await runWeeklySocialPost("tenant-1", MONDAY);

    expect(result.status).toBe("published");
    expect(result.metaPostId).toBe("page_123");
    expect(metaClientMock.publishTextPost).toHaveBeenCalledWith("A real, grounded post about our routes.");
  });
});

describe("runWeeklySocialPost — unexpected error", () => {
  it("records the error and rethrows, never silently swallowing an unexpected failure", async () => {
    contentSourceMock.getRealPostDataSnapshot.mockRejectedValue(new Error("db exploded"));

    await expect(runWeeklySocialPost("tenant-1", MONDAY)).rejects.toThrow("db exploded");
    expect(fakeState.posts[0]?.status).toBe("failed");
    expect(fakeState.posts[0]?.metaError).toBe("db exploded");
  });

  it("also marks Instagram failed with the same reason — neither platform had a post to publish", async () => {
    contentSourceMock.getRealPostDataSnapshot.mockRejectedValue(new Error("db exploded"));

    await expect(runWeeklySocialPost("tenant-1", MONDAY)).rejects.toThrow("db exploded");
    expect(fakeState.posts[0]?.instagramStatus).toBe("failed");
    expect(fakeState.posts[0]?.instagramError).toBe("db exploded");
  });
});

describe("runWeeklySocialPost — Instagram not configured", () => {
  it("still publishes to Facebook and marks Instagram 'skipped', not 'failed'", async () => {
    const result = await runWeeklySocialPost("tenant-1", MONDAY);

    expect(result.status).toBe("published");
    expect(result.instagramStatus).toBe("skipped");
    expect(result.instagramMediaId).toBeNull();
    expect(metaClientMock.publishInstagramPost).not.toHaveBeenCalled();
  });
});

describe("runWeeklySocialPost — Instagram configured", () => {
  beforeEach(() => {
    process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = "ig-123";
    process.env.INSTAGRAM_POST_IMAGE_URL = "https://example.com/brand-photo.jpg";
  });

  it("publishes to both Facebook and Instagram from the same generated content", async () => {
    const result = await runWeeklySocialPost("tenant-1", MONDAY);

    expect(result.status).toBe("published");
    expect(result.instagramStatus).toBe("published");
    expect(result.instagramMediaId).toBe("ig_123");
    expect(metaClientMock.publishInstagramPost).toHaveBeenCalledWith(
      "A real, grounded post about our routes.",
      "https://example.com/brand-photo.jpg",
    );
  });

  it("a Facebook Graph API failure never blocks a successful Instagram publish", async () => {
    metaClientMock.publishTextPost.mockResolvedValue({ ok: false, error: "Invalid OAuth access token." });

    const result = await runWeeklySocialPost("tenant-1", MONDAY);

    expect(result.status).toBe("failed");
    expect(result.metaError).toBe("Invalid OAuth access token.");
    expect(result.instagramStatus).toBe("published");
    expect(result.instagramMediaId).toBe("ig_123");
  });

  it("an Instagram Graph API failure never blocks a successful Facebook publish", async () => {
    metaClientMock.publishInstagramPost.mockResolvedValue({ ok: false, error: "Invalid image URL." });

    const result = await runWeeklySocialPost("tenant-1", MONDAY);

    expect(result.status).toBe("published");
    expect(result.metaPostId).toBe("page_123");
    expect(result.instagramStatus).toBe("failed");
    expect(result.instagramError).toBe("Invalid image URL.");
  });

  it("fails Instagram without calling its Graph API when the caption is too long for Instagram", async () => {
    validatorMock.validateInstagramCaptionLength.mockReturnValue("caption is too long for Instagram (2201 chars, maximum 2200)");

    const result = await runWeeklySocialPost("tenant-1", MONDAY);

    expect(result.status).toBe("published");
    expect(result.instagramStatus).toBe("failed");
    expect(result.instagramError).toContain("too long for Instagram");
    expect(metaClientMock.publishInstagramPost).not.toHaveBeenCalled();
  });
});
