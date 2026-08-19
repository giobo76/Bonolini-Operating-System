import { createHmac, timingSafeEqual } from "node:crypto";
import { log, captureException } from "../observability";
import { whatsappWebhookPayloadSchema, extractMessages } from "./schema";
import { processInboundMessage } from "./service";
import type { ParsedWhatsappMessage } from "./schema";
import { processTransferRequestForMessageAndPrice } from "../transfer-requests";
import type { TransferRequestExtractedFields } from "../transfer-requests";

// The transport-framework-agnostic core of GET/POST
// /api/whatsapp/webhook (apps/transfer-admin/app/api/whatsapp/webhook/
// route.ts) — kept here, not in the route handler, so it's unit-testable
// with the same vitest pattern already used for
// packages/core/src/marketing/lead-intent-handler.ts, and so route.ts stays
// a thin Next.js adapter (same split, same rationale).

// ── Signature verification (POST) ────────────────────────────────────────
// Meta signs the raw request body with the app secret — HMAC-SHA256, header
// `X-Hub-Signature-256: sha256=<hex>`. Verified against the exact raw body
// string, before any JSON parsing (a re-serialized JSON.stringify(parsed)
// would not byte-for-byte match what was signed). Timing-safe comparison,
// same rationale as any secret-comparison code.
export function verifyMetaSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader) return false;

  const [scheme, hex] = signatureHeader.split("=");
  if (scheme !== "sha256" || !hex) return false;

  const expectedHex = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  const provided = Buffer.from(hex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
}

// ── GET: Meta's subscription verification challenge ─────────────────────

export interface WhatsappVerificationResult {
  status: number;
  body: string;
}

export function handleWhatsappVerification(
  query: { mode: string | null; verifyToken: string | null; challenge: string | null },
  expectedVerifyToken: string,
): WhatsappVerificationResult {
  if (query.mode === "subscribe" && query.verifyToken === expectedVerifyToken && query.challenge) {
    log("whatsapp.webhook.verified", {});
    return { status: 200, body: query.challenge };
  }

  log("whatsapp.webhook.verification_rejected", {});
  return { status: 403, body: "forbidden" };
}

// ── Bridge to transfer-requests ──────────────────────────────────────────
// Direct field subset of ParsedWhatsappMessage -> TransferRequestExtractedFields
// (same shape proven in transfer-requests/whatsapp-pricing-simulation.integration.test.ts) —
// no parsing, merge, missing-information, customerType, or pricing logic
// here, all of that stays inside transfer-requests' own module per ADR 0002.
function toTransferRequestExtractedFields(parsed: ParsedWhatsappMessage): TransferRequestExtractedFields {
  return {
    intent: parsed.intent,
    pickup: parsed.pickup,
    destination: parsed.destination,
    date: parsed.date,
    time: parsed.time,
    passengers: parsed.passengers,
    luggage: parsed.luggage,
    flight: parsed.flight,
    train: parsed.train,
    hotel: parsed.hotel,
    language: parsed.language,
  };
}

// ── POST: inbound message delivery ───────────────────────────────────────

export interface WhatsappWebhookRequestInput {
  rawBody: string;
  signatureHeader: string | null;
  appSecret: string | undefined;
}

export interface WhatsappWebhookResult {
  status: number;
  body: { ok: boolean; error?: string };
}

export async function handleWhatsappWebhookRequest(
  input: WhatsappWebhookRequestInput,
): Promise<WhatsappWebhookResult> {
  if (!input.appSecret) {
    // Config error, not a caller error — never falls back to "accept
    // unverified" behavior.
    captureException(new Error("WHATSAPP_APP_SECRET not configured"), "whatsapp.webhook.config_error");
    return { status: 500, body: { ok: false, error: "internal_error" } };
  }

  if (!verifyMetaSignature(input.rawBody, input.signatureHeader, input.appSecret)) {
    log("whatsapp.webhook.rejected", { reason: "invalid_signature" });
    return { status: 401, body: { ok: false, error: "invalid_signature" } };
  }

  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    log("whatsapp.webhook.rejected", { reason: "invalid_json" });
    return { status: 400, body: { ok: false, error: "invalid_payload" } };
  }

  const parsed = whatsappWebhookPayloadSchema.safeParse(json);
  if (!parsed.success) {
    log("whatsapp.webhook.rejected", { reason: "invalid_payload" });
    return { status: 400, body: { ok: false, error: "invalid_payload" } };
  }

  const messages = extractMessages(parsed.data);
  log("whatsapp.webhook.received", { messageCount: messages.length });

  // Fail soft per message: one malformed/erroring message must not drop the
  // rest of the batch or cause Meta to retry the whole payload forever.
  for (const message of messages) {
    try {
      const result = await processInboundMessage(message);
      log("whatsapp.webhook.message_processed", { status: result.status });

      // Only a message that resolved to a client with parsed data can drive
      // a transfer request — a non-text message (parsed === null) has
      // nothing to extract. Inline, synchronous call for this first real
      // connection (no Inngest event yet — see transfer-requests/README.md's
      // "Integration is a separate, deliberate next step"). Safe to run on
      // both "processed" and "duplicate" (a Meta retry): processTransferRequestForMessage
      // is idempotent per whatsapp_messages.id (see its own doc comment).
      if (result.clientId && result.parsed) {
        try {
          const priced = await processTransferRequestForMessageAndPrice({
            tenantId: result.tenantId,
            clientId: result.clientId,
            whatsappMessageId: result.messageId,
            extracted: toTransferRequestExtractedFields(result.parsed),
          });
          log("whatsapp.webhook.transfer_request_processed", {
            status: priced.status,
            pricingStatus: priced.pricingStatus,
          });
        } catch (error) {
          captureException(error, "whatsapp.webhook.transfer_request_failed");
        }
      }
    } catch (error) {
      captureException(error, "whatsapp.webhook.message_failed");
    }
  }

  return { status: 200, body: { ok: true } };
}
