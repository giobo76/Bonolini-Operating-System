# whatsapp — WhatsApp → BOS integration

**Status:** Phase 1 only — receive and normalize inbound messages. No outbound messaging, no chatbot, no automated quotes/bookings, no price/availability logic. See "Hard constraints" below.

**Owns:** the `whatsapp_messages` table (inbound message log: `tenant_id, client_id, whatsapp_message_id, from_phone, raw_text, parsed, received_at`) and the logic to receive, verify, deduplicate, and interpret inbound WhatsApp Cloud API webhook deliveries.

**Exposes:** `handleWhatsappVerification`, `handleWhatsappWebhookRequest` (consumed by `apps/transfer-admin/app/api/whatsapp/webhook/route.ts` — the only caller), `processInboundMessage`, `parseWhatsappMessage`, `normalizePhone`.

**Emits:** — (no Inngest events yet; Phase 1 is synchronous request → DB write, same as `lead-intent-handler.ts`).

**Listens to:** — (webhook-triggered, not event-triggered).

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this and every other domain module follows.

## Why a new table, not an existing one

Verified before building (not assumed): neither `clients.notes` (a single overwritable text field), `quotes` (a status+amount skeleton with no trip-detail columns), nor `marketing_leads` (deliberately anonymous — no phone/text, per its own header comment) can hold per-message WhatsApp data with real idempotency. `whatsapp_messages` is the minimal addition: one row per inbound message, a DB-level unique constraint on `whatsapp_message_id` (not an in-memory Set — this app runs serverless/multi-instance on Vercel, the same reason `rate-limit.ts` is documented as best-effort only), and a `parsed` jsonb column for whatever Claude extracts.

## Flow (Phase 1)

1. Meta POSTs to `/api/whatsapp/webhook`. `route.ts` reads the raw body (needed for signature verification) and delegates to `webhook-handler.ts`.
2. `verifyMetaSignature` checks `X-Hub-Signature-256` (HMAC-SHA256 over the raw body, timing-safe compare) against `WHATSAPP_APP_SECRET`. Missing/invalid → 401/500, no DB write, no Claude call.
3. The payload is validated (`whatsappWebhookPayloadSchema`) and flattened into individual messages (`extractMessages`).
4. Per message, `processInboundMessage` (`service.ts`):
   - Inserts into `whatsapp_messages` with `ON CONFLICT (whatsapp_message_id) DO NOTHING` — the real idempotency boundary. If the insert is a no-op, the existing row is returned as-is: no second client, no second Claude call.
   - Finds an existing `clients` row by phone (normalized to digits-only on both sides — WhatsApp sends `393281234567`, but `clients.phone` has no such guarantee since it's hand-entered via the web lead form) or creates one. **One client per phone number, not one per message.**
   - Calls `parseWhatsappMessage` (text messages only) — Claude tool-use extraction, mirrors `packages/core/src/marketing/strategist.ts`'s pattern exactly (forced tool-use, zod-validated output, fail-soft on any error or missing `ANTHROPIC_API_KEY`). Every field is optional; the system prompt forbids inventing anything not explicitly in the message.
   - Persists `parsed` + `client_id` on the message row, and conservatively enriches the client (`email`/`preferredLanguage`, **only if currently null** — never overwrites existing data, never touches `fullName` after creation).

## Decisions made during implementation worth the founder's review

These were genuine judgment calls not fully specified by the approved design — flagged rather than silently decided:

1. **New client's `fullName`**: uses WhatsApp's own contact profile name (`contacts[].profile.name`, real platform data) when Meta provides one; falls back to the phone number itself when it doesn't (`clients.fullName` is `NOT NULL`) — never a fabricated placeholder like "Unknown Customer."
2. **`clients.phone` is not unique** (called out explicitly in the approved design, not resolved by it) — when more than one client matches the same normalized phone, the most recently created one is used.
3. **Phone matching** uses `regexp_replace(phone, '[^0-9]', '', 'g')` for digits-only comparison (no index on this expression — the table is small; a functional index can be added later if this becomes a real query cost).
4. **Non-text message types** (image, location, etc.) still get a `whatsapp_messages` row (for idempotency/audit) and still trigger client find-or-create (needs only the phone), but are never sent to Claude and store a placeholder `raw_text` — Phase 1 only interprets text.
5. **New client's `notes`** is left untouched (unlike `clients.submitLead`, which prefixes the initial message into `notes`) — the raw message text already lives in `whatsapp_messages.raw_text`; reusing `notes` for this would give it a second, inconsistent meaning.

## Hard constraints (Phase 1 — do not relax without the founder reopening this decision)

- No outbound WhatsApp messages, ever (no `WHATSAPP_ACCESS_TOKEN` configured — intentionally not requested this phase).
- No automated replies, no chatbot, no automated quotes, no price/availability logic.
- Never invents data: every field the parser doesn't find in the message is omitted, not guessed.
- Never overwrites existing client data with null/undefined, and never merges multiple messages into a new lead — one client per phone number.
- Idempotency is real (DB unique constraint), not best-effort.
