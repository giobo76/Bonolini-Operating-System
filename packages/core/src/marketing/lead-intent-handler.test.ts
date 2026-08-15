import { describe, expect, it, vi, beforeEach } from "vitest";

// Unit tests for the framework-agnostic core behind POST/OPTIONS
// /api/marketing/lead-intent — see the file's own header comment for why
// this logic lives here (testable via the module's existing vitest setup)
// rather than in apps/transfer-admin, which has no test infrastructure at
// all. @bos/db is never touched — only ./service's recordLeadIntent is
// mocked, so no real database call happens anywhere in this file.

const recordLeadIntent = vi.fn();
vi.mock("./service", () => ({ recordLeadIntent: (...a: unknown[]) => recordLeadIntent(...a) }));

const { handleLeadIntentRequest, handleLeadIntentPreflight, ALLOWED_ORIGIN } = await import(
  "./lead-intent-handler"
);

const validBody = JSON.stringify({
  channel: "whatsapp",
  utmSource: "google",
  utmCampaign: "summer",
  gclid: "abc123",
  landingPage: "https://bonolinitransfer.com/",
  referrer: "https://google.com/",
  visitorId: "visitor-1",
});

describe("handleLeadIntentRequest", () => {
  beforeEach(() => {
    recordLeadIntent.mockClear();
  });

  it("1. valid POST from the allowed origin -> 201, ok:true, and calls recordLeadIntent", async () => {
    recordLeadIntent.mockResolvedValueOnce({ id: "lead-1" });

    const result = await handleLeadIntentRequest({
      origin: ALLOWED_ORIGIN,
      rawBody: validBody,
      rateLimitKey: "ip-1",
    });

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ ok: true });
    expect(result.corsOrigin).toBe(ALLOWED_ORIGIN);
    expect(recordLeadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "whatsapp", gclid: "abc123" }),
    );
  });

  it("2. invalid channel -> 400, no write attempted", async () => {
    const body = JSON.stringify({ channel: "carrier_pigeon" });

    const result = await handleLeadIntentRequest({ origin: ALLOWED_ORIGIN, rawBody: body, rateLimitKey: "ip-2" });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "invalid_payload" });
    expect(recordLeadIntent).not.toHaveBeenCalled();
  });

  it("3. tenantId in the payload -> rejected (400), not silently stripped", async () => {
    const body = JSON.stringify({ channel: "whatsapp", tenantId: "some-other-tenant" });

    const result = await handleLeadIntentRequest({ origin: ALLOWED_ORIGIN, rawBody: body, rateLimitKey: "ip-3" });

    expect(result.status).toBe(400);
    expect(recordLeadIntent).not.toHaveBeenCalled();
  });

  it("4. clientId in the payload -> rejected (400), not silently stripped", async () => {
    const body = JSON.stringify({ channel: "whatsapp", clientId: "11111111-1111-1111-1111-111111111111" });

    const result = await handleLeadIntentRequest({ origin: ALLOWED_ORIGIN, rawBody: body, rateLimitKey: "ip-4" });

    expect(result.status).toBe(400);
    expect(recordLeadIntent).not.toHaveBeenCalled();
  });

  it("5. PII fields in the payload -> rejected (400)", async () => {
    const body = JSON.stringify({
      channel: "phone",
      fullName: "Mario Rossi",
      phone: "+393281234567",
      email: "mario@example.com",
      notes: "wants a quote",
      message: "hi",
    });

    const result = await handleLeadIntentRequest({ origin: ALLOWED_ORIGIN, rawBody: body, rateLimitKey: "ip-5" });

    expect(result.status).toBe(400);
    expect(recordLeadIntent).not.toHaveBeenCalled();
  });

  it("6. allowed origin -> request is processed (corsOrigin set to the allowed origin)", async () => {
    recordLeadIntent.mockResolvedValueOnce({ id: "lead-6" });

    const result = await handleLeadIntentRequest({
      origin: "https://bonolinitransfer.com",
      rawBody: validBody,
      rateLimitKey: "ip-6",
    });

    expect(result.corsOrigin).toBe("https://bonolinitransfer.com");
    expect(result.status).toBe(201);
  });

  it("7. different origin -> 403, no CORS header value, no write attempted", async () => {
    const result = await handleLeadIntentRequest({
      origin: "https://evil.example.com",
      rawBody: validBody,
      rateLimitKey: "ip-7",
    });

    expect(result.status).toBe(403);
    expect(result.corsOrigin).toBeNull();
    expect(recordLeadIntent).not.toHaveBeenCalled();
  });

  it("7b. missing origin header -> 403, treated the same as a disallowed origin", async () => {
    const result = await handleLeadIntentRequest({ origin: null, rawBody: validBody, rateLimitKey: "ip-7b" });

    expect(result.status).toBe(403);
    expect(result.corsOrigin).toBeNull();
    expect(recordLeadIntent).not.toHaveBeenCalled();
  });

  it("9. rate limit: the 21st request within the window from the same key -> 429", async () => {
    recordLeadIntent.mockResolvedValue({ id: "lead-x" });
    const key = "ip-ratelimit-test";

    for (let i = 0; i < 20; i++) {
      const r = await handleLeadIntentRequest({ origin: ALLOWED_ORIGIN, rawBody: validBody, rateLimitKey: key });
      expect(r.status).toBe(201);
    }

    const blocked = await handleLeadIntentRequest({ origin: ALLOWED_ORIGIN, rawBody: validBody, rateLimitKey: key });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ ok: false, error: "rate_limited" });
  });

  it("10. recordLeadIntent throws -> 500 with a generic error, no internal details leaked", async () => {
    recordLeadIntent.mockRejectedValueOnce(new Error("connection to postgres://user:pass@host/db failed"));

    const result = await handleLeadIntentRequest({
      origin: ALLOWED_ORIGIN,
      rawBody: validBody,
      rateLimitKey: "ip-10",
    });

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ ok: false, error: "internal_error" });
    expect(JSON.stringify(result.body)).not.toContain("postgres://");
  });

  it("oversized payload -> 400, no write attempted", async () => {
    const body = JSON.stringify({ channel: "whatsapp", visitorId: "x".repeat(20_000) });

    const result = await handleLeadIntentRequest({ origin: ALLOWED_ORIGIN, rawBody: body, rateLimitKey: "ip-11" });

    expect(result.status).toBe(400);
    expect(recordLeadIntent).not.toHaveBeenCalled();
  });

  it("malformed JSON -> 400, not a 500", async () => {
    const result = await handleLeadIntentRequest({
      origin: ALLOWED_ORIGIN,
      rawBody: "{not json",
      rateLimitKey: "ip-12",
    });

    expect(result.status).toBe(400);
    expect(recordLeadIntent).not.toHaveBeenCalled();
  });
});

describe("handleLeadIntentPreflight (OPTIONS)", () => {
  it("8a. allowed origin -> 204 with CORS origin set", () => {
    const result = handleLeadIntentPreflight(ALLOWED_ORIGIN);
    expect(result.status).toBe(204);
    expect(result.corsOrigin).toBe(ALLOWED_ORIGIN);
  });

  it("8b. disallowed origin -> 204 but no CORS origin set (browser blocks the follow-up request)", () => {
    const result = handleLeadIntentPreflight("https://evil.example.com");
    expect(result.status).toBe(204);
    expect(result.corsOrigin).toBeNull();
  });
});
