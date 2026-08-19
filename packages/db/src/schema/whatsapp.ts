import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { clients } from "./clients";
import { transferRequests } from "./transfer-requests";

// ── WhatsApp inbound message log ─────────────────────────────────────────
// One row per inbound WhatsApp message. Exists because idempotency
// (whatsapp_message_id must survive Meta's webhook retries across separate
// serverless invocations — an in-memory Set does not) and the original
// message text/per-message extracted data have no home in any existing
// table: clients.notes is a single overwritable field, quotes is a
// status+amount skeleton with no trip-detail fields, marketing_leads is
// deliberately anonymous (no phone/text). See packages/core/src/whatsapp/
// README.md for the full rationale.

// Indexes (including the unique constraint on whatsappMessageId that is the
// real idempotency boundary) are defined in the SQL migration, not here —
// same convention as every other table in this schema directory: drizzle-kit
// has never actually been run in this environment, so hand-authored SQL is
// the source of truth for indexes/constraints, and this file only declares
// column shapes for the query builder's types.
export const whatsappMessages = pgTable("whatsapp_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  // Set once the sender's phone is matched/created against `clients` — see
  // service.ts's find-or-create-by-phone flow. Nullable + on delete set
  // null: the message log outlives the client relationship.
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
  // Set once this message has been merged into (or has created) a transfer
  // request — see packages/core/src/transfer-requests. Null for messages
  // never routed through that logic (non-text, test messages, etc.).
  transferRequestId: uuid("transfer_request_id").references(() => transferRequests.id, { onDelete: "set null" }),
  // Meta's message id (wamid...). The real idempotency boundary is the
  // composite (tenant_id, whatsapp_message_id) unique index in the SQL
  // migration, not application-level pre-checks — a message id is only
  // guaranteed unique within the WhatsApp Business Account it came from.
  whatsappMessageId: text("whatsapp_message_id").notNull(),
  // As received from the webhook (`messages[].from` / `contacts[].wa_id`),
  // digits only, no leading "+". Not assumed unique — see service.ts's
  // phone-normalization note on why clients.phone can't be matched by
  // simple equality.
  fromPhone: text("from_phone").notNull(),
  // Original message text, verbatim, never altered — conserved
  // independently of whatever the parser extracts from it.
  rawText: text("raw_text").notNull(),
  // ParsedWhatsappMessage (packages/core/src/whatsapp/schema.ts), or null
  // if parsing hasn't run yet (non-text message types) or found nothing.
  // Every field nullable/absent by construction — the parser never invents
  // a value it isn't confident about.
  parsed: jsonb("parsed"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WhatsappMessage = typeof whatsappMessages.$inferSelect;
export type NewWhatsappMessage = typeof whatsappMessages.$inferInsert;
