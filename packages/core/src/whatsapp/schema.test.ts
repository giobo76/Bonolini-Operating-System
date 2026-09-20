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
  // Phase 3B — omit entirely to simulate Meta not sending a metadata
  // block at all; pass a value (including one shaped unexpectedly) to
  // exercise extraction/validation.
  metadata?: unknown;
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
              ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
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

// Phase 3B — discovery/persistence of value.metadata.phone_number_id /
// .display_phone_number. Pure extraction logic, same testing style as the
// rest of this file — no DB, no outbound send is exercised or implied.
describe("extractMessages — metadata (phone_number_id / display_phone_number)", () => {
  // 1/2. a payload with both fields present -> both extracted correctly
  it("1/2: extracts both phone_number_id and display_phone_number when Meta sends them", () => {
    const payload = whatsappWebhookPayloadSchema.parse(
      textMessagePayload({ metadata: { display_phone_number: "393280000000", phone_number_id: "1234567890" } }),
    );

    const messages = extractMessages(payload);

    expect(messages[0]!.phoneNumberId).toBe("1234567890");
    expect(messages[0]!.displayPhoneNumber).toBe("393280000000");
  });

  it("applies the same metadata to every message extracted from the same change block", () => {
    const raw = textMessagePayload({
      id: "wamid.FIRST",
      metadata: { display_phone_number: "393280000000", phone_number_id: "1234567890" },
    });
    raw.entry[0]!.changes[0]!.value.messages.push({
      from: "393281234567",
      id: "wamid.SECOND",
      timestamp: "1755500100",
      type: "text",
      text: { body: "second message, same change block" },
    } as never);
    const payload = whatsappWebhookPayloadSchema.parse(raw);

    const messages = extractMessages(payload);

    expect(messages).toHaveLength(2);
    expect(messages[0]!.phoneNumberId).toBe("1234567890");
    expect(messages[1]!.phoneNumberId).toBe("1234567890");
  });

  // 3. metadata assente
  it("3: leaves both fields null when Meta sends no metadata block at all", () => {
    const payload = whatsappWebhookPayloadSchema.parse(textMessagePayload({}));

    const messages = extractMessages(payload);

    expect(messages[0]!.phoneNumberId).toBeNull();
    expect(messages[0]!.displayPhoneNumber).toBeNull();
  });

  // 4. display_phone_number assente (ma phone_number_id presente)
  it("4: extracts phone_number_id alone when display_phone_number is absent", () => {
    const payload = whatsappWebhookPayloadSchema.parse(
      textMessagePayload({ metadata: { phone_number_id: "1234567890" } }),
    );

    const messages = extractMessages(payload);

    expect(messages[0]!.phoneNumberId).toBe("1234567890");
    expect(messages[0]!.displayPhoneNumber).toBeNull();
  });

  // 5. valore non valido — mai inventato, mai propagato, il messaggio
  // intero continua a essere processato normalmente (rawText, ecc.)
  it("5a: a non-string phone_number_id is treated as absent, never coerced", () => {
    const payload = whatsappWebhookPayloadSchema.parse(
      textMessagePayload({ metadata: { phone_number_id: 1234567890, display_phone_number: "393280000000" } }),
    );

    const messages = extractMessages(payload);

    expect(messages[0]!.phoneNumberId).toBeNull(); // never coerced from a number
    expect(messages[0]!.displayPhoneNumber).toBe("393280000000"); // sibling field unaffected
  });

  it("5b: an empty-string phone_number_id is treated as absent", () => {
    const payload = whatsappWebhookPayloadSchema.parse(
      textMessagePayload({ metadata: { phone_number_id: "", display_phone_number: "393280000000" } }),
    );

    const messages = extractMessages(payload);

    expect(messages[0]!.phoneNumberId).toBeNull();
  });

  it("5c: a metadata block that is itself the wrong type (a string, not an object) never fails validation or extraction", () => {
    const result = whatsappWebhookPayloadSchema.safeParse(textMessagePayload({ metadata: "not-an-object" }));
    expect(result.success).toBe(true); // whole payload still validates (rule 6/7: never fail the message unnecessarily)

    if (result.success) {
      const messages = extractMessages(result.data);
      expect(messages[0]!.phoneNumberId).toBeNull();
      expect(messages[0]!.displayPhoneNumber).toBeNull();
      // the rest of the message is entirely unaffected
      expect(messages[0]!.rawText).toBe("Hello");
    }
  });

  // 6. il comportamento del messaggio normale non cambia
  it("6: every other extracted field is unaffected by metadata presence/absence", () => {
    const withMetadata = extractMessages(
      whatsappWebhookPayloadSchema.parse(
        textMessagePayload({ from: "393281234567", body: "Ciao", metadata: { phone_number_id: "123" } }),
      ),
    )[0]!;
    const withoutMetadata = extractMessages(
      whatsappWebhookPayloadSchema.parse(textMessagePayload({ from: "393281234567", body: "Ciao" })),
    )[0]!;

    expect(withMetadata.waMessageId).toBe(withoutMetadata.waMessageId);
    expect(withMetadata.fromPhone).toBe(withoutMetadata.fromPhone);
    expect(withMetadata.rawText).toBe(withoutMetadata.rawText);
    expect(withMetadata.type).toBe(withoutMetadata.type);
  });

  // 7. nessun secret nei dati estratti — l'estrazione legge solo i due
  // campi previsti, non propaga l'intero blocco metadata (che in un
  // payload reale non contiene comunque mai un secret, ma la disciplina
  // "mai un passthrough non necessario di dati esterni" vale comunque).
  it("7: extraction reads only the two expected fields, never the whole metadata object", () => {
    const payload = whatsappWebhookPayloadSchema.parse(
      textMessagePayload({
        metadata: { phone_number_id: "123", display_phone_number: "393280000000", unexpected_field: "should-not-leak" },
      }),
    );

    const messages = extractMessages(payload);
    const keys = Object.keys(messages[0]!);

    expect(keys).not.toContain("metadata");
    expect(keys).not.toContain("unexpected_field");
    expect(JSON.stringify(messages[0])).not.toContain("should-not-leak");
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
