import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ../whatsapp mocked at the module boundary (ADR 0002) — this file tests
// WhatsAppCloudApiProvider's own logic (window check, payload shape,
// validation, Graph API response handling), never re-exercising
// getLastInboundReceivedAt's own already-tested query logic.
const mockGetLastInboundReceivedAt = vi.fn();
vi.mock("../whatsapp", () => ({
  getLastInboundReceivedAt: (...args: unknown[]) => mockGetLastInboundReceivedAt(...args),
}));

const { WhatsAppCloudApiProvider, isE164 } = await import("./whatsapp-cloud-api-provider");
const { getConfiguredOutboundProvider, NotConfiguredOutboundProvider } = await import("./provider");

const TENANT = "tenant-1";
const CLIENT = "client-1";
const TOKEN = "test-access-token-do-not-log";
const PHONE_NUMBER_ID = "1153269981201077";

function baseRequest(overrides: Partial<Parameters<InstanceType<typeof WhatsAppCloudApiProvider>["send"]>[0]> = {}) {
  return {
    channel: "whatsapp",
    to: "+393331234567",
    body: "Ciao, ecco la nostra offerta",
    idempotencyKey: "quote_offer:quote-1",
    tenantId: TENANT,
    clientId: CLIENT,
    ...overrides,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  mockGetLastInboundReceivedAt.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_TEMPLATE_NAME;
  delete process.env.WHATSAPP_TEMPLATE_LANGUAGE;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isE164", () => {
  it("accepts a real E.164 number", () => {
    expect(isE164("+393331234567")).toBe(true);
    expect(isE164("+15556720885")).toBe(true);
  });

  it("rejects anything without a leading '+', or with letters/spaces", () => {
    expect(isE164("393331234567")).toBe(false);
    expect(isE164("+39 333 123 4567")).toBe(false);
    expect(isE164("+39-333-1234567")).toBe(false);
    expect(isE164("not a phone number")).toBe(false);
    expect(isE164("")).toBe(false);
  });
});

// 1/2/3. provider factory — NOT_CONFIGURED unless BOTH required env vars are set
describe("getConfiguredOutboundProvider — WhatsApp env wiring", () => {
  it("1: returns NotConfiguredOutboundProvider when nothing is configured", () => {
    const provider = getConfiguredOutboundProvider();
    expect(provider).toBeInstanceOf(NotConfiguredOutboundProvider);
  });

  it("2: returns NotConfiguredOutboundProvider when WHATSAPP_ACCESS_TOKEN is missing", () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = PHONE_NUMBER_ID;
    const provider = getConfiguredOutboundProvider();
    expect(provider).toBeInstanceOf(NotConfiguredOutboundProvider);
  });

  it("3: returns NotConfiguredOutboundProvider when WHATSAPP_PHONE_NUMBER_ID is missing", () => {
    process.env.WHATSAPP_ACCESS_TOKEN = TOKEN;
    const provider = getConfiguredOutboundProvider();
    expect(provider).toBeInstanceOf(NotConfiguredOutboundProvider);
  });

  it("returns a real WhatsAppCloudApiProvider once both are set, never a false success from NotConfigured", () => {
    process.env.WHATSAPP_ACCESS_TOKEN = TOKEN;
    process.env.WHATSAPP_PHONE_NUMBER_ID = PHONE_NUMBER_ID;
    const provider = getConfiguredOutboundProvider();
    expect(provider).toBeInstanceOf(WhatsAppCloudApiProvider);
    expect(provider.name).toBe("whatsapp_cloud_api");
  });
});

// 4. recipient non E.164
describe("recipient validation", () => {
  it("4: refuses to send to a non-E.164 recipient, never attempting a fetch call", async () => {
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);

    await expect(provider.send(baseRequest({ to: "3331234567" }))).rejects.toThrow(/not a valid E\.164/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never auto-corrects an ambiguous number — rejects outright instead of guessing", async () => {
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);
    await expect(provider.send(baseRequest({ to: "0039 333 1234567" }))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// 5/6. finestra 24 ore — free-form dentro/fuori finestra
describe("24h customer service window", () => {
  it("5: sends a free-form text message when the client's last inbound is within 24h", async () => {
    mockGetLastInboundReceivedAt.mockResolvedValue(new Date(Date.now() - 60 * 60 * 1000)); // 1h ago
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), { status: 200 }),
    );
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);

    await provider.send(baseRequest());

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.type).toBe("text");
    expect(sentBody.text.body).toBe("Ciao, ecco la nostra offerta");
  });

  it("6: never sends free-form once the window is closed, even with a template available", async () => {
    mockGetLastInboundReceivedAt.mockResolvedValue(new Date(Date.now() - 30 * 60 * 60 * 1000)); // 30h ago
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), { status: 200 }));
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, { name: "quote_offer", language: "it" });

    await provider.send(baseRequest());

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.type).not.toBe("text");
    expect(sentBody.type).toBe("template");
  });

  // Regression (production, 2026-09-24): Postgres/postgres-js hand raw
  // timestamps back as text like "2026-09-24 10:15:30.123+00", not Date —
  // the provider called .getTime() on it and every send failed with
  // "c.getTime is not a function".
  function pgTimestamp(date: Date): string {
    return date.toISOString().replace("T", " ").replace("Z", "+00");
  }

  it("works when the last inbound time arrives as Postgres text (inside the window)", async () => {
    mockGetLastInboundReceivedAt.mockResolvedValue(pgTimestamp(new Date(Date.now() - 60 * 60 * 1000)));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), { status: 200 }));
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);

    await expect(provider.send(baseRequest())).resolves.toEqual({ status: "sent", providerMessageId: "wamid.OK" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string).type).toBe("text");
  });

  it("works when the last inbound time arrives as Postgres text (window closed)", async () => {
    mockGetLastInboundReceivedAt.mockResolvedValue(pgTimestamp(new Date(Date.now() - 30 * 60 * 60 * 1000)));
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);

    await expect(provider.send(baseRequest())).rejects.toThrow(/window is closed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unreadable last inbound time counts as 'no inbound', never as an open window", async () => {
    mockGetLastInboundReceivedAt.mockResolvedValue("not a timestamp");
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);

    await expect(provider.send(baseRequest())).rejects.toThrow(/window is closed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a client with no inbound history at all as outside the window", async () => {
    mockGetLastInboundReceivedAt.mockResolvedValue(null);
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);

    await expect(provider.send(baseRequest())).rejects.toThrow(/window is closed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // 19. tenant isolation — the window check is always scoped by the
  // request's own tenantId/clientId, never a global/shared lookup.
  it("19: passes the exact tenantId/clientId from the request to the window check — never a different one", async () => {
    mockGetLastInboundReceivedAt.mockResolvedValue(new Date());
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), { status: 200 }));
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);

    await provider.send(baseRequest({ tenantId: "tenant-XYZ", clientId: "client-XYZ" }));

    expect(mockGetLastInboundReceivedAt).toHaveBeenCalledWith("tenant-XYZ", "client-XYZ");
  });
});

// 7/8. template fuori finestra — configurato vs non configurato
describe("template outside the window", () => {
  it("7: builds a template payload (name + language, no invented parameters) when configured", async () => {
    mockGetLastInboundReceivedAt.mockResolvedValue(new Date(Date.now() - 48 * 60 * 60 * 1000));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.TPL" }] }), { status: 200 }));
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, { name: "quote_offer_v1", language: "it" });

    const result = await provider.send(baseRequest());

    expect(result).toEqual({ status: "sent", providerMessageId: "wamid.TPL" });
    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody).toMatchObject({
      messaging_product: "whatsapp",
      type: "template",
      template: { name: "quote_offer_v1", language: { code: "it" } },
    });
  });

  it("8: refuses to send (execution_failed via a thrown error) when outside the window and no template is configured", async () => {
    mockGetLastInboundReceivedAt.mockResolvedValue(new Date(Date.now() - 48 * 60 * 60 * 1000));
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);

    await expect(provider.send(baseRequest())).rejects.toThrow(/no WhatsApp template is configured/);
    expect(fetchMock).not.toHaveBeenCalled(); // never a fallback attempt
  });
});

// 9/10. Meta API success/failure
describe("Graph API response handling", () => {
  it("9: returns the real providerMessageId Meta issued — never invented", async () => {
    mockGetLastInboundReceivedAt.mockResolvedValue(new Date());
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.REAL_ID_12345" }] }), {
        status: 200,
      }),
    );
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);

    const result = await provider.send(baseRequest());

    expect(result).toEqual({ status: "sent", providerMessageId: "wamid.REAL_ID_12345" });
  });

  it("10: a Graph API error response throws (never a fabricated providerMessageId)", async () => {
    mockGetLastInboundReceivedAt.mockResolvedValue(new Date());
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid parameter" } }), { status: 400 }),
    );
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);

    await expect(provider.send(baseRequest())).rejects.toThrow(/Invalid parameter/);
  });

  it("a 200 response with no messages[0].id in the body still throws, never invents an id", async () => {
    mockGetLastInboundReceivedAt.mockResolvedValue(new Date());
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messaging_product: "whatsapp" }), { status: 200 }));
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);

    await expect(provider.send(baseRequest())).rejects.toThrow();
  });

  it("a network-level failure (fetch itself rejects) throws, never silently succeeds", async () => {
    mockGetLastInboundReceivedAt.mockResolvedValue(new Date());
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);

    await expect(provider.send(baseRequest())).rejects.toThrow(/ECONNRESET/);
  });
});

// 20. nessun secret nei log
describe("no secrets in logs (rule: never print WHATSAPP_ACCESS_TOKEN)", () => {
  it("20: the access token never appears in console output on success or failure", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockGetLastInboundReceivedAt.mockResolvedValue(new Date());
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400 }));
      const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);

      await provider.send(baseRequest());
      await provider.send(baseRequest()).catch(() => undefined);

      const allOutput = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((call) => JSON.stringify(call)).join("\n");
      expect(allOutput).not.toContain(TOKEN);
      expect(allOutput).not.toContain("Authorization");
      expect(allOutput).not.toContain("Bearer");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("the request body sent to fetch never leaks the token (it belongs only in the Authorization header)", async () => {
    mockGetLastInboundReceivedAt.mockResolvedValue(new Date());
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), { status: 200 }));
    const provider = new WhatsAppCloudApiProvider(TOKEN, PHONE_NUMBER_ID, null);

    await provider.send(baseRequest());

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).body as string).not.toContain(TOKEN);
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
