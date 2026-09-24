import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { clients } from "./clients";
import { transferRequests } from "./transfer-requests";
import { communications } from "./communications";

// Owned by packages/core/src/quote-approval. Unique/partial indexes live in
// migration 0028 (same "SQL is the source of truth for constraints"
// convention as whatsapp.ts).

// Messages from FOUNDER_WHATSAPP_PHONE never enter whatsapp_messages: that
// table feeds client matching and transfer_requests, and the founder is not
// a customer. Kept separately for Meta-retry dedup and for the founder's own
// 24h WhatsApp window.
export const founderWhatsappMessages = pgTable("founder_whatsapp_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  whatsappMessageId: text("whatsapp_message_id").notNull(),
  type: text("type").notNull(),
  rawText: text("raw_text"),
  buttonId: text("button_id"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per "PREVENTIVO PRONTO" round sent to the founder. A MODIFICA
// supersedes the current round and opens round+1 at the proposed price, so
// a button from an older message can never act on the newer price.
//
// kind: quote_ready | manual_price_required
// status: awaiting_decision | awaiting_price | processing | approved |
//         rejected | superseded | info
// notificationStatus: pending | sending | sent_whatsapp | sent_email | failed
export const quoteApprovalRequests = pgTable("quote_approval_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  transferRequestId: uuid("transfer_request_id")
    .notNull()
    .references(() => transferRequests.id, { onDelete: "cascade" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  round: integer("round").notNull().default(1),
  status: text("status").notNull(),
  // null on round 1 (the engine's calculated price applies); set on every
  // round opened by a MODIFICA.
  proposedAmountCents: integer("proposed_amount_cents"),
  // null = the default deposit (50% of the price, nearest 10 €) applies.
  proposedDepositCents: integer("proposed_deposit_cents"),
  notificationStatus: text("notification_status").notNull().default("pending"),
  notificationChannel: text("notification_channel"),
  notificationError: text("notification_error"),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionError: text("decision_error"),
  customerCommunicationId: uuid("customer_communication_id").references(() => communications.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FounderWhatsappMessage = typeof founderWhatsappMessages.$inferSelect;
export type QuoteApprovalRequest = typeof quoteApprovalRequests.$inferSelect;
export type NewQuoteApprovalRequest = typeof quoteApprovalRequests.$inferInsert;
