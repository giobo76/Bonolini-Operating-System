import { describe, expect, it } from "vitest";
import { whatsappWebhookPayloadSchema, extractMessages, parsedWhatsappMessageSchema } from "./schema";

// 1. Schema validation for the inbound webhook payload + extraction logic
// that flattens Meta's entry[].changes[].value shape into per-message
// records. Pure, no I/O — same testing style as ga4-checks.ts's
// severityForBaseline.

function textMessagePayload(overrides: {
  from?: string;
  id?: string;
  timestamp?: string;
  body?: string;
  profileName?: string;
}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "entry-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [
                {
                  wa_id: overrides.from ?? "393281234567",
                  profile: overrides.profileName ? { name: overrides.profileName } : undefined,
                },
              ],
              messages: [
                {
                  from: overrides.from ?? "393281234567",
                  id: overrides.id ?? "wamid.ABC123",
                  timestamp: overrides.timestamp ?? "1755500000",
                  type: "text",
                  text: { body: overrides.body ?? "Hello" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("whatsappWebhookPayloadSchema", () => {
  it("accepts a well-formed text-message payload", () => {
    const result = whatsappWebhookPayloadSchema.safeParse(textMessagePayload({}));
    expect(result.success).toBe(true);
  });

  it("accepts unknown extra fields Meta might add (passthrough)", () => {
    const payload = { ...textMessagePayload({}), some_future_field: "x" };
    const result = whatsappWebhookPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("rejects a payload that isn't an object at all", () => {
    expect(whatsappWebhookPayloadSchema.safeParse(42).success).toBe(false);
    expect(whatsappWebhookPayloadSchema.safeParse("not json").success).toBe(false);
  });

  it("accepts a status-only callback (no messages array)", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: "entry-1", changes: [{ field: "messages", value: { statuses: [{ status: "delivered" }] } }] }],
    };
    expect(whatsappWebhookPayloadSchema.safeParse(payload).success).toBe(true);
  });
});

describe("extractMessages", () => {
  it("extracts a text message with its matching contact profile name", () => {
    const payload = whatsappWebhookPayloadSchema.parse(
      textMessagePayload({ from: "393281234567", profileName: "Mario Rossi", body: "Hi there" }),
    );

    const messages = extractMessages(payload);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      waMessageId: "wamid.ABC123",
      fromPhone: "393281234567",
      type: "text",
      rawText: "Hi there",
      profileName: "Mario Rossi",
    });
  });

  it("leaves profileName null when no matching contact is present", () => {
    const raw = textMessagePayload({});
    raw.entry[0]!.changes[0]!.value.contacts = [];
    const payload = whatsappWebhookPayloadSchema.parse(raw);

    const messages = extractMessages(payload);

    expect(messages[0]!.profileName).toBeNull();
  });

  it("sets rawText null for non-text message types", () => {
    const raw = textMessagePayload({});
    raw.entry[0]!.changes[0]!.value.messages[0] = {
      from: "393281234567",
      id: "wamid.IMG1",
      timestamp: "1755500000",
      type: "image",
    } as never;
    const payload = whatsappWebhookPayloadSchema.parse(raw);

    const messages = extractMessages(payload);

    expect(messages[0]!.type).toBe("image");
    expect(messages[0]!.rawText).toBeNull();
  });

  it("converts the unix-seconds timestamp to a Date", () => {
    const payload = whatsappWebhookPayloadSchema.parse(textMessagePayload({ timestamp: "1755500000" }));

    const messages = extractMessages(payload);

    expect(messages[0]!.receivedAt.getTime()).toBe(1755500000 * 1000);
  });

  it("returns an empty array for a status-only callback (no messages)", () => {
    const payload = whatsappWebhookPayloadSchema.parse({
      object: "whatsapp_business_account",
      entry: [{ id: "entry-1", changes: [{ field: "messages", value: { statuses: [{ status: "read" }] } }] }],
    });

    expect(extractMessages(payload)).toEqual([]);
  });

  // Coverage gap flagged in the pre-commit review: extractMessages was only
  // ever exercised with a single message per payload.
  it("extracts every message when a single webhook payload carries more than one", () => {
    const raw = textMessagePayload({ from: "393281234567", id: "wamid.FIRST", body: "Ciao" });
    raw.entry[0]!.changes[0]!.value.messages.push({
      from: "393281234567",
      id: "wamid.SECOND",
      timestamp: "1755500100",
      type: "text",
      text: { body: "Sono a Milano, mi serve un transfer domani per 4 persone" },
    } as never);
    const payload = whatsappWebhookPayloadSchema.parse(raw);

    const messages = extractMessages(payload);

    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.waMessageId)).toEqual(["wamid.FIRST", "wamid.SECOND"]);
    expect(messages[1]!.rawText).toBe("Sono a Milano, mi serve un transfer domani per 4 persone");
  });

  it("extracts messages spread across multiple entry[] items in the same payload", () => {
    const payload = whatsappWebhookPayloadSchema.parse({
      object: "whatsapp_business_account",
      entry: [
        textMessagePayload({ from: "393281111111", id: "wamid.A" }).entry[0]!,
        textMessagePayload({ from: "393282222222", id: "wamid.B" }).entry[0]!,
      ],
    });

    const messages = extractMessages(payload);

    expect(messages.map((m) => m.waMessageId)).toEqual(["wamid.A", "wamid.B"]);
  });
});

describe("parsedWhatsappMessageSchema", () => {
  it("accepts an object with every field present", () => {
    const result = parsedWhatsappMessageSchema.safeParse({
      fullName: "Mario Rossi",
      pickup: "Milan",
      destination: "Tirano",
      passengers: 4,
      date: "2026-08-19",
      intent: "transfer_request",
      missingInformation: ["time"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an entirely empty object (nothing extracted)", () => {
    expect(parsedWhatsappMessageSchema.safeParse({}).success).toBe(true);
  });

  it("rejects a malformed value for a typed field instead of coercing it", () => {
    const result = parsedWhatsappMessageSchema.safeParse({ passengers: "four" });
    expect(result.success).toBe(false);
  });

  // Problema 3 (pre-commit review): an empty/whitespace string for one
  // field must not invalidate the whole object and lose the other,
  // genuinely-present fields.
  it("6: treats an empty string field as absent, without losing the other valid fields", () => {
    const result = parsedWhatsappMessageSchema.safeParse({
      pickup: "Milan",
      destination: "",
      passengers: 4,
      hotel: "   ",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pickup).toBe("Milan");
      expect(result.data.passengers).toBe(4);
      expect(result.data.destination).toBeUndefined();
      expect(result.data.hotel).toBeUndefined();
    }
  });

  it("still rejects a genuinely invalid value alongside empty strings (empty strings aren't a silent catch-all)", () => {
    const result = parsedWhatsappMessageSchema.safeParse({ pickup: "", passengers: "not a number" });
    expect(result.success).toBe(false);
  });
});
