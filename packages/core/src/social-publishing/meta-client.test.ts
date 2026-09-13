import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { publishTextPost, publishInstagramPost } from "./meta-client";

// global fetch is stubbed for every test in this file — no automated test
// ever makes a real network call to graph.facebook.com.
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FACEBOOK_PAGE_ID;
  delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  delete process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
});

describe("publishTextPost — missing configuration", () => {
  it("fails without calling fetch when FACEBOOK_PAGE_ID is not set", async () => {
    delete process.env.FACEBOOK_PAGE_ID;
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "token-123";

    const result = await publishTextPost("Hello world");

    expect(result).toEqual({ ok: false, error: expect.stringContaining("FACEBOOK_PAGE_ID") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails without calling fetch when FACEBOOK_PAGE_ACCESS_TOKEN is not set", async () => {
    process.env.FACEBOOK_PAGE_ID = "12345";
    delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

    const result = await publishTextPost("Hello world");

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("publishTextPost — configured", () => {
  beforeEach(() => {
    process.env.FACEBOOK_PAGE_ID = "12345";
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "secret-token";
  });

  it("posts to the versioned Graph API feed endpoint with the message and access token", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "12345_67890" }) });

    const result = await publishTextPost("Hello world");

    expect(result).toEqual({ ok: true, postId: "12345_67890" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/12345\/feed$/);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as { message: string; access_token: string };
    expect(body.message).toBe("Hello world");
    expect(body.access_token).toBe("secret-token");
  });

  it("never leaks the access token into the returned result on success or failure", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "1_2" }) });
    const ok = await publishTextPost("Hi");
    expect(JSON.stringify(ok)).not.toContain("secret-token");

    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: "bad request" } }) });
    const failed = await publishTextPost("Hi");
    expect(JSON.stringify(failed)).not.toContain("secret-token");
  });

  it("returns the Graph API's own error message on a non-2xx response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Invalid OAuth access token." } }),
    });

    const result = await publishTextPost("Hello world");

    expect(result).toEqual({ ok: false, error: "Invalid OAuth access token." });
  });

  it("falls back to the HTTP status when the error body has no message", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => null });

    const result = await publishTextPost("Hello world");

    expect(result).toEqual({ ok: false, error: "Graph API returned HTTP 500" });
  });

  it("catches a network-level failure (fetch throwing) without crashing the caller", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const result = await publishTextPost("Hello world");

    expect(result).toEqual({ ok: false, error: "network down" });
  });
});

describe("publishInstagramPost — missing configuration", () => {
  it("fails without calling fetch when INSTAGRAM_BUSINESS_ACCOUNT_ID is not set", async () => {
    delete process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "token-123";

    const result = await publishInstagramPost("A caption", "https://example.com/photo.jpg");

    expect(result).toEqual({ ok: false, error: expect.stringContaining("INSTAGRAM_BUSINESS_ACCOUNT_ID") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails without calling fetch when FACEBOOK_PAGE_ACCESS_TOKEN is not set", async () => {
    process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = "ig-123";
    delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

    const result = await publishInstagramPost("A caption", "https://example.com/photo.jpg");

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("publishInstagramPost — configured", () => {
  beforeEach(() => {
    process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = "ig-123";
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "secret-token";
  });

  it("creates a media container then publishes it, reusing the Page access token for both calls", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "container-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "media-1" }) });

    const result = await publishInstagramPost("A real caption", "https://example.com/photo.jpg");

    expect(result).toEqual({ ok: true, mediaId: "media-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [containerUrl, containerInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(containerUrl).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/ig-123\/media$/);
    const containerBody = JSON.parse(containerInit.body as string) as {
      image_url: string;
      caption: string;
      access_token: string;
    };
    expect(containerBody.image_url).toBe("https://example.com/photo.jpg");
    expect(containerBody.caption).toBe("A real caption");
    expect(containerBody.access_token).toBe("secret-token");

    const [publishUrl, publishInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(publishUrl).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/ig-123\/media_publish$/);
    const publishBody = JSON.parse(publishInit.body as string) as { creation_id: string; access_token: string };
    expect(publishBody.creation_id).toBe("container-1");
    expect(publishBody.access_token).toBe("secret-token");
  });

  it("never leaks the access token into the returned result on success or failure", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "container-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "media-1" }) });
    const ok = await publishInstagramPost("Hi", "https://example.com/photo.jpg");
    expect(JSON.stringify(ok)).not.toContain("secret-token");

    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: "bad request" } }) });
    const failed = await publishInstagramPost("Hi", "https://example.com/photo.jpg");
    expect(JSON.stringify(failed)).not.toContain("secret-token");
  });

  it("fails without publishing when the media container creation itself fails", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Invalid image URL." } }),
    });

    const result = await publishInstagramPost("A caption", "https://example.com/bad.jpg");

    expect(result).toEqual({ ok: false, error: "Invalid image URL." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the Graph API's own error message when the publish step itself fails", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "container-1" }) })
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: "Media not ready." } }) });

    const result = await publishInstagramPost("A caption", "https://example.com/photo.jpg");

    expect(result).toEqual({ ok: false, error: "Media not ready." });
  });

  it("catches a network-level failure without crashing the caller", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const result = await publishInstagramPost("A caption", "https://example.com/photo.jpg");

    expect(result).toEqual({ ok: false, error: "network down" });
  });
});
