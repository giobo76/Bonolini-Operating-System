import { createHmac } from "node:crypto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const processInboundMessage = vi.fn();
vi.mock("./service", () => ({ processInboundMessage: (...args: unknown[]) => processInboundMessage(...args) }));

const { verifyMetaSignature, handleWhatsappVerification, handleWhatsappWebhookRequest } = await import(
  "./webhook-handler"
);

const APP_SECRET = "test-app-secret-do-not-use";

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

const VALID_PAYLOAD = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "entry-1",
      changes: [
        {
          field: "messages",
          value: {
            contacts: [{ wa_id: "393281234567", profile: { name: "Mario Rossi" } }],
            messages: [
              { from: "393281234567", id: "wamid.ABC123", timestamp: "1755500000", type: "text", text: { body: "Hi" } },
            ],
          },
        },
      ],
    },
  ],
});

describe("verifyMetaSignature", () => {
  it("5: accepts a correctly computed sha256 signature", () => {
    const signature = sign(VALID_PAYLOAD, APP_SECRET);
    expect(verifyMetaSignature(VALID_PAYLOAD, signature, APP_SECRET)).toBe(true);
  });

  it("6: rejects a signature computed with the wrong secret", () => {
    const signature = sign(VALID_PAYLOAD, "wrong-secret");
    expect(verifyMetaSignature(VALID_PAYLOAD, signature, APP_SECRET)).toBe(false);
  });

  it("6b: rejects a malformed signature header (wrong scheme / not hex)", () => {
    expect(verifyMetaSignature(VALID_PAYLOAD, "md5=deadbeef", APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(VALID_PAYLOAD, "sha256=not-hex-at-all", APP_SECRET)).toBe(false);
  });

  it("7: rejects when no signature header is present", () => {
    expect(verifyMetaSignature(VALID_PAYLOAD, null, APP_SECRET)).toBe(false);
  });
});

describe("handleWhatsappVerification (GET)", () => {
  it("returns the challenge when mode and token match", () => {
    const result = handleWhatsappVerification(
      { mode: "subscribe", verifyToken: "correct-token", challenge: "challenge-123" },
      "correct-token",
    );
    expect(result).toEqual({ status: 200, body: "challenge-123" });
  });

  it("rejects a wrong verify token", () => {
    const result = handleWhatsappVerification(
      { mode: "subscribe", verifyToken: "wrong-token", challenge: "challenge-123" },
      "correct-token",
    );
    expect(result.status).toBe(403);
  });
});

describe("handleWhatsappWebhookRequest (POST)", () => {
  beforeEach(() => {
    processInboundMessage.mockReset();
    processInboundMessage.mockResolvedValue({ status: "processed", messageId: "msg-1", clientId: "client-1", parsed: {} });
  });

  it("5: processes the payload and returns 200 when the signature is valid", async () => {
    const signature = sign(VALID_PAYLOAD, APP_SECRET);

    const result = await handleWhatsappWebhookRequest({
      rawBody: VALID_PAYLOAD,
      signatureHeader: signature,
      appSecret: APP_SECRET,
    });

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(processInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("6: rejects with 401 and does not process anything when the signature is invalid", async () => {
    const result = await handleWhatsappWebhookRequest({
      rawBody: VALID_PAYLOAD,
      signatureHeader: sign(VALID_PAYLOAD, "wrong-secret"),
      appSecret: APP_SECRET,
    });

    expect(result.status).toBe(401);
    expect(processInboundMessage).not.toHaveBeenCalled();
  });

  it("7: rejects with 401 and does not process anything when the signature is absent", async () => {
    const result = await handleWhatsappWebhookRequest({
      rawBody: VALID_PAYLOAD,
      signatureHeader: null,
      appSecret: APP_SECRET,
    });

    expect(result.status).toBe(401);
    expect(processInboundMessage).not.toHaveBeenCalled();
  });

  it("returns 500 and does not process anything when WHATSAPP_APP_SECRET is not configured", async () => {
    const result = await handleWhatsappWebhookRequest({
      rawBody: VALID_PAYLOAD,
      signatureHeader: sign(VALID_PAYLOAD, APP_SECRET),
      appSecret: undefined,
    });

    expect(result.status).toBe(500);
    expect(processInboundMessage).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON with 400 after a valid signature", async () => {
    const badBody = "not json";
    const result = await handleWhatsappWebhookRequest({
      rawBody: badBody,
      signatureHeader: sign(badBody, APP_SECRET),
      appSecret: APP_SECRET,
    });

    expect(result.status).toBe(400);
    expect(processInboundMessage).not.toHaveBeenCalled();
  });

  // 7. payload with more than one message in the same webhook delivery
  it("7: processes every message when the payload carries more than one", async () => {
    const multiMessagePayload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "entry-1",
          changes: [
            {
              field: "messages",
              value: {
                contacts: [{ wa_id: "393281234567", profile: { name: "Mario Rossi" } }],
                messages: [
                  { from: "393281234567", id: "wamid.FIRST", timestamp: "1755500000", type: "text", text: { body: "Ciao" } },
                  { from: "393281234567", id: "wamid.SECOND", timestamp: "1755500100", type: "text", text: { body: "Serve un transfer domani" } },
                ],
              },
            },
          ],
        },
      ],
    });

    const result = await handleWhatsappWebhookRequest({
      rawBody: multiMessagePayload,
      signatureHeader: sign(multiMessagePayload, APP_SECRET),
      appSecret: APP_SECRET,
    });

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(processInboundMessage).toHaveBeenCalledTimes(2);
  });

  it("does not fail the whole batch when processInboundMessage throws for one message", async () => {
    processInboundMessage.mockRejectedValue(new Error("db down"));

    const result = await handleWhatsappWebhookRequest({
      rawBody: VALID_PAYLOAD,
      signatureHeader: sign(VALID_PAYLOAD, APP_SECRET),
      appSecret: APP_SECRET,
    });

    expect(result).toEqual({ status: 200, body: { ok: true } });
  });
});

describe("14: no secrets ever reach the log output", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    processInboundMessage.mockReset();
    processInboundMessage.mockResolvedValue({ status: "processed", messageId: "msg-1", clientId: "client-1", parsed: {} });
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  function allLoggedText(): string {
    return [...consoleLogSpy.mock.calls, ...consoleErrorSpy.mock.calls].map((call) => JSON.stringify(call)).join("\n");
  }

  it("never logs the app secret or the raw request body, on the valid-signature path", async () => {
    await handleWhatsappWebhookRequest({
      rawBody: VALID_PAYLOAD,
      signatureHeader: sign(VALID_PAYLOAD, APP_SECRET),
      appSecret: APP_SECRET,
    });

    const logged = allLoggedText();
    expect(logged).not.toContain(APP_SECRET);
    expect(logged).not.toContain(VALID_PAYLOAD);
    expect(logged).not.toContain("Mario Rossi");
  });

  it("never logs the app secret on the invalid-signature/rejected path", async () => {
    await handleWhatsappWebhookRequest({
      rawBody: VALID_PAYLOAD,
      signatureHeader: "sha256=wrong",
      appSecret: APP_SECRET,
    });

    const logged = allLoggedText();
    expect(logged).not.toContain(APP_SECRET);
    expect(logged).not.toContain(VALID_PAYLOAD);
  });
});
