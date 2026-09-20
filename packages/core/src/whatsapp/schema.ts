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
    // Phase 3B — the business account/number Meta routed this change
    // through (phone_number_id, display_phone_number). Deliberately
    // z.unknown() here, not a typed object: this is discovery/persistence
    // only (see extractPhoneNumberId/extractDisplayPhoneNumber below),
    // and a malformed or unexpected shape here must never fail validation
    // for the whole payload — every other message in the same delivery
    // still needs to process normally. The real, defensive type-checking
    // happens at extraction time instead, same discipline
    // parsedWhatsappMessageSchema's dropEmptyStrings already applies one
    // layer down.
    metadata: z.unknown().optional(),
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
  // Phase 3B — discovery/persistence only (see whatsapp/README.md's own
  // "Hard constraints": no outbound capability is built from this).
  // Both null whenever Meta's payload doesn't carry a `metadata` block, or
  // carries one that doesn't have a valid (non-empty string) value for
  // this specific field — never guessed, never defaulted to a previously
  // seen value.
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
}

// Defensive extraction, not schema validation: `metadata` is typed
// z.unknown() at the schema level specifically so a malformed shape here
// never fails validation for the whole webhook payload (see
// whatsappChangeValueSchema's own comment). Mirrors dropEmptyStrings
// below — a present-but-not-a-real-string value is treated exactly like
// an absent one, never invented, never coerced.
function extractMetadataStringField(metadata: unknown, field: "phone_number_id" | "display_phone_number"): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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
      // One metadata block per change (`value.metadata`), applied to
      // every message extracted from it — Meta's own shape: `metadata`
      // describes the business account/number the whole `value` block was
      // routed through, never a per-message field.
      const phoneNumberId = extractMetadataStringField(change.value.metadata, "phone_number_id");
      const displayPhoneNumber = extractMetadataStringField(change.value.metadata, "display_phone_number");

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
          phoneNumberId,
          displayPhoneNumber,
        });
      }
    }
  }

  return extracted;
}

// ── Delivery-status callbacks (Phase 3B Step 3) ───────────────────────────
// Meta's webhook delivers status updates through the same entry[].changes[]
// shape as inbound messages, but as change.value.statuses[] instead of
// .messages[] — see whatsappChangeValueSchema's own `statuses` field
// (already accepted, previously never read). Each item's `id` is the exact
// WAMID returned by the original send call (communications.provider_message_id),
// which is what correlates a callback back to the right communication —
// see packages/core/src/communications/service.ts's
// recordProviderDeliveryStatus. Never used to send anything; read-only
// correlation.
export interface WhatsappStatusCallback {
  providerMessageId: string;
  status: string;
  occurredAt: Date;
}

// Defensive extraction, not schema validation — same discipline as
// extractMetadataStringField above: `statuses` is typed z.array(z.unknown())
// at the schema level specifically so a malformed status item never fails
// validation for the whole webhook payload. A status item missing `id` or
// `status` (or carrying the wrong type for either) is silently skipped,
// never guessed.
function extractStatusCallback(raw: unknown): WhatsappStatusCallback | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id.trim().length === 0) return null;
  if (typeof value.status !== "string" || value.status.trim().length === 0) return null;

  const timestampMs = typeof value.timestamp === "string" ? Number(value.timestamp) * 1000 : NaN;
  return {
    providerMessageId: value.id,
    status: value.status,
    occurredAt: Number.isFinite(timestampMs) ? new Date(timestampMs) : new Date(),
  };
}

export function extractStatuses(payload: WhatsappWebhookPayload): WhatsappStatusCallback[] {
  const extracted: WhatsappStatusCallback[] = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const statuses = change.value.statuses ?? [];
      for (const raw of statuses) {
        const status = extractStatusCallback(raw);
        if (status) extracted.push(status);
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
