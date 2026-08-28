import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { sendGa4ConversionEvent, trackLeadConversion, resolveGa4ClientId } from "./measurement-protocol";

describe("sendGa4ConversionEvent", () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.GA4_MEASUREMENT_ID = "G-TEST123";
    process.env.GA4_MEASUREMENT_PROTOCOL_API_SECRET = "test-secret";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it("fails soft (sent: false, no throw) when GA4_MEASUREMENT_ID is not set", async () => {
    delete process.env.GA4_MEASUREMENT_ID;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await sendGa4ConversionEvent({ clientId: "123.456", eventName: "generate_lead" });

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/GA4_MEASUREMENT_ID/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails soft when GA4_MEASUREMENT_PROTOCOL_API_SECRET is not set", async () => {
    delete process.env.GA4_MEASUREMENT_PROTOCOL_API_SECRET;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await sendGa4ConversionEvent({ clientId: "123.456", eventName: "generate_lead" });

    expect(result.sent).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends exactly one POST to the Measurement Protocol collect endpoint with the right client_id and event name", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await sendGa4ConversionEvent({ clientId: "123.456", eventName: "generate_lead" });

    expect(result).toEqual({ sent: true, reason: undefined });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("measurement_id=G-TEST123");
    expect(url).toContain("api_secret=test-secret");
    const body = JSON.parse(options.body);
    expect(body).toEqual({ client_id: "123.456", events: [{ name: "generate_lead", params: {} }] });
  });

  it("never fabricates a value/currency param on the event", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    global.fetch = fetchSpy as unknown as typeof fetch;

    await sendGa4ConversionEvent({ clientId: "123.456", eventName: "generate_lead" });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.events[0].params).toEqual({});
  });

  it("reports sent: false with the HTTP status when the collect call itself fails, without throwing", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400 }) as unknown as typeof fetch;

    const result = await sendGa4ConversionEvent({ clientId: "123.456", eventName: "generate_lead" });

    expect(result).toEqual({ sent: false, reason: "HTTP 400" });
  });
});

describe("trackLeadConversion", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.GA4_MEASUREMENT_ID = "G-TEST123";
    process.env.GA4_MEASUREMENT_PROTOCOL_API_SECRET = "test-secret";
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("always sends the literal event name generate_lead — matching ga4-checks.ts's EXPECTED_EVENTS exactly", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    global.fetch = fetchSpy as unknown as typeof fetch;

    await trackLeadConversion("123.456");

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.events[0].name).toBe("generate_lead");
  });
});

describe("resolveGa4ClientId", () => {
  it("extracts the client_id portion from a real _ga cookie value", () => {
    expect(resolveGa4ClientId("GA1.1.987654321.1700000000", () => "fallback")).toBe("987654321.1700000000");
  });

  it("falls back when the _ga cookie is absent", () => {
    expect(resolveGa4ClientId(undefined, () => "generated-fallback-id")).toBe("generated-fallback-id");
  });

  it("falls back when the _ga cookie value doesn't match the expected shape", () => {
    expect(resolveGa4ClientId("not-a-ga-cookie", () => "generated-fallback-id")).toBe("generated-fallback-id");
  });
});
