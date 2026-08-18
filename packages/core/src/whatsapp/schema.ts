import { z } from "zod";

// ── Meta WhatsApp Cloud API webhook payload ──────────────────────────────
// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks — shape
// documented from Meta's spec (no live account connected in this
// environment, same caveat already recorded for the Marketing Intelligence
// Engine's Google API clients). .passthrough() everywhere: we only need to
// read a few fields out of a payload Meta can extend at any time — the goal
// is never to reject a real webhook delivery for carrying fields we don't
// consume yet.

const whatsappContactSchema = z
  .object({
    wa_id: z.string().optional(),
    profile: z.object({ name: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const whatsappInboundMessageSchema = z
  .object({
    from: z.string().min(1),
    id: z.string().min(1),
    timestamp: z.string().min(1),
    type: z.string().min(1),
    text: z.object({ body: z.string() }).passthrough().optional(),
  })
  .passthrough();

const whatsappChangeValueSchema = z
  .object({
    messaging_product: z.string().optional(),
    contacts: z.array(whatsappContactSchema).optional(),
    messages: z.array(whatsappInboundMessageSchema).optional(),
    // Delivery/read status callbacks — same "changes" shape, no `messages`
    // array. Validated as unknown[] so a status-only payload still passes
    // schema validation; the extraction step below simply finds nothing to
    // process for it.
    statuses: z.array(z.unknown()).optional(),
  })
  .passthrough();

const whatsappChangeSchema = z
  .object({
    field: z.string().optional(),
    value: whatsappChangeValueSchema,
  })
  .passthrough();

const whatsappEntrySchema = z
  .object({
    id: z.string().optional(),
    changes: z.array(whatsappChangeSchema).default([]),
  })
  .passthrough();

export const whatsappWebhookPayloadSchema = z
  .object({
    object: z.string().optional(),
    entry: z.array(whatsappEntrySchema).default([]),
  })
  .passthrough();

export type WhatsappWebhookPayload = z.infer<typeof whatsappWebhookPayloadSchema>;
export type WhatsappInboundMessage = z.infer<typeof whatsappInboundMessageSchema>;
export type WhatsappContact = z.infer<typeof whatsappContactSchema>;

// A single inbound message, already matched with its sender's contact
// profile (if Meta included one) — the shape service.ts actually works
// with, after flattening entry[].changes[].value.
export interface ExtractedWhatsappMessage {
  waMessageId: string;
  fromPhone: string;
  type: string;
  rawText: string | null;
  profileName: string | null;
  receivedAt: Date;
}

// entry[].changes[].value.messages[] paired with the matching contacts[]
// entry (by wa_id) — pure, no I/O, easy to unit test independent of the
// webhook transport.
export function extractMessages(payload: WhatsappWebhookPayload): ExtractedWhatsappMessage[] {
  const extracted: ExtractedWhatsappMessage[] = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const messages = change.value.messages ?? [];
      const contacts = change.value.contacts ?? [];

      for (const message of messages) {
        const contact = contacts.find((c) => c.wa_id === message.from);
        const timestampMs = Number(message.timestamp) * 1000;

        extracted.push({
          waMessageId: message.id,
          fromPhone: message.from,
          type: message.type,
          rawText: message.type === "text" ? (message.text?.body ?? null) : null,
          profileName: contact?.profile?.name ?? null,
          receivedAt: Number.isFinite(timestampMs) ? new Date(timestampMs) : new Date(),
        });
      }
    }
  }

  return extracted;
}

// ── Parsed message data (Claude extraction output) ───────────────────────
// Every field optional/nullable by design — see parser.ts's system prompt.
// "Do not invent missing information" is enforced by never marking a field
// required here, not by post-hoc validation.

const parsedWhatsappMessageObjectSchema = z.object({
  fullName: z.string().trim().min(1).optional(),
  phone: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  pickup: z.string().trim().min(1).optional(),
  destination: z.string().trim().min(1).optional(),
  date: z.string().trim().min(1).optional(),
  time: z.string().trim().min(1).optional(),
  passengers: z.number().int().positive().optional(),
  luggage: z.string().trim().min(1).optional(),
  flight: z.string().trim().min(1).optional(),
  train: z.string().trim().min(1).optional(),
  hotel: z.string().trim().min(1).optional(),
  language: z.string().trim().min(1).optional(),
  intent: z.string().trim().min(1).optional(),
  missingInformation: z.array(z.string().trim().min(1)).optional(),
});

// PRE-COMMIT FIX: nothing in the tool schema (parser.ts's EXTRACTION_TOOL)
// forbids Claude from returning an empty/whitespace-only string for a field
// instead of omitting it. Every field above uses .min(1), so without this
// preprocessing step, a single empty-string field would fail validation for
// the *entire* object — discarding otherwise-valid data in every other
// field, not just the empty one. An empty string is treated exactly like an
// absent field (dropped before validation), never as an invented value —
// and it never causes sibling fields to be lost.
function dropEmptyStrings(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim().length === 0) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

export const parsedWhatsappMessageSchema = z.preprocess(dropEmptyStrings, parsedWhatsappMessageObjectSchema);

export type ParsedWhatsappMessage = z.infer<typeof parsedWhatsappMessageSchema>;
