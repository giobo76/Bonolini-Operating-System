import { describe, expect, it, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    lastInboundAt: null as Date | null,
    posted: [] as Array<Record<string, unknown>>,
    postError: null as Error | null,
    emails: [] as Array<{ to: string; subject: string; text: string }>,
    emailError: null as { message: string } | null,
  },
}));

vi.mock("./repository", () => ({
  getFounderLastInboundAt: async () => state.lastInboundAt,
}));

vi.mock("../communications", () => ({
  isE164: (phone: string) => /^\+[1-9]\d{1,14}$/.test(phone),
  getWhatsappCloudApiCredentials: () => ({ accessToken: "token", phoneNumberId: "phone-id" }),
  postWhatsappCloudApiMessage: async (_a: string, _p: string, payload: Record<string, unknown>) => {
    if (state.postError) throw state.postError;
    state.posted.push(payload);
    return `wamid.${state.posted.length}`;
  },
}));

vi.mock("../whatsapp", () => ({
  normalizePhone: (phone: string) => phone.replace(/[^0-9]/g, ""),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (email: { to: string; subject: string; text: string }) => {
        state.emails.push(email);
        return { error: state.emailError };
      },
    };
  },
}));

const { sendToFounder, isFounderPhone } = await import("./founder-channel");

const BUTTONS = [
  { id: "qa:1:approve", title: "APPROVA" },
  { id: "qa:1:modify", title: "MODIFICA" },
  { id: "qa:1:reject", title: "RIFIUTA" },
];

beforeEach(() => {
  state.lastInboundAt = new Date();
  state.posted = [];
  state.postError = null;
  state.emails = [];
  state.emailError = null;
  process.env.FOUNDER_WHATSAPP_PHONE = "+39 333 111 2222";
  process.env.RESEND_API_KEY = "re_test";
  process.env.MARKETING_ALERT_EMAIL = "founder@example.com";
});

describe("isFounderPhone", () => {
  it("matches the configured number regardless of formatting", () => {
    expect(isFounderPhone("393331112222")).toBe(true);
    expect(isFounderPhone("393339999999")).toBe(false);
  });

  it("never matches when FOUNDER_WHATSAPP_PHONE is not set", () => {
    delete process.env.FOUNDER_WHATSAPP_PHONE;
    expect(isFounderPhone("393331112222")).toBe(false);
  });
});

describe("sendToFounder", () => {
  it("sends one interactive message with the reply buttons inside the 24h window", async () => {
    const result = await sendToFounder("tenant-1", { parts: ["anteprima", "dettagli"], buttons: BUTTONS, emailSubject: "s" });

    expect(result).toEqual({ channel: "whatsapp", error: null });
    expect(state.posted).toHaveLength(1);
    expect(state.posted[0]).toMatchObject({
      to: "393331112222",
      type: "interactive",
      interactive: { type: "button", body: { text: "anteprima\n\ndettagli" } },
    });
    expect(state.emails).toHaveLength(0);
  });

  it("sends the earlier parts as plain text when everything does not fit in 1024 chars", async () => {
    const preview = "x".repeat(1100);
    await sendToFounder("tenant-1", { parts: [preview, "dettagli"], buttons: BUTTONS, emailSubject: "s" });

    expect(state.posted.map((p) => p.type)).toEqual(["text", "interactive"]);
    expect(state.posted[1]).toMatchObject({ interactive: { body: { text: "dettagli" } } });
  });

  it("falls back to email with the same content when the 24h window is closed", async () => {
    state.lastInboundAt = new Date(Date.now() - 25 * 60 * 60 * 1000);

    const result = await sendToFounder("tenant-1", {
      parts: ["anteprima", "PREVENTIVO PRONTO dettagli"],
      buttons: BUTTONS,
      emailSubject: "PREVENTIVO PRONTO #abc",
    });

    expect(state.posted).toHaveLength(0);
    expect(result.channel).toBe("email");
    expect(state.emails[0]!.to).toBe("founder@example.com");
    expect(state.emails[0]!.subject).toBe("PREVENTIVO PRONTO #abc");
    expect(state.emails[0]!.text).toContain("PREVENTIVO PRONTO dettagli");
    expect(state.emails[0]!.text).toContain("finestra WhatsApp di 24 ore");
    expect(state.emails[0]!.text).toContain("scrivi un messaggio qualsiasi");
  });

  it("falls back to email when the founder never wrote to the business number", async () => {
    state.lastInboundAt = null;
    const result = await sendToFounder("tenant-1", { parts: ["x"], emailSubject: "s" });
    expect(result.channel).toBe("email");
  });

  it("falls back to email when Meta rejects the WhatsApp send", async () => {
    state.postError = new Error("FounderWhatsapp: (#131047) Re-engagement message");
    const result = await sendToFounder("tenant-1", { parts: ["x"], emailSubject: "s" });
    expect(result.channel).toBe("email");
    expect(state.emails[0]!.text).toContain("131047");
  });

  it("reports a failure (never a fake success) when both channels fail", async () => {
    state.lastInboundAt = null;
    state.emailError = { message: "domain not verified" };
    const result = await sendToFounder("tenant-1", { parts: ["x"], emailSubject: "s" });
    expect(result.channel).toBe("none");
    expect(result.error).toContain("domain not verified");
  });
});
