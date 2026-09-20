import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { clients } from "./clients";

// BOS Business Intelligence + Autonomy Model, Phase 2.5 — the persistent
// aggregate a client's negotiation lives in across however many
// transfer_request attempts it takes. Exists because transfer_requests
// (see its own header comment) is deliberately scoped to "one row per
// in-progress request ATTEMPT" — its own matching rules intentionally stop
// treating a request as "open" the moment it's priced (pending_admin_approval)
// or approved, so a later WhatsApp message about the SAME negotiation (a
// question about payment, a confirmation, a follow-up) had nowhere
// persistent to attach to and silently spawned a new, disconnected
// transfer_request instead — verified against a real production incident
// (2026-09-18: one client, four transfer_requests, the same €300 fixed fare
// computed twice). See packages/core/src/deals/README.md for the full
// matching algorithm this table backs.
export const dealStatusEnum = pgEnum("deal_status", ["open", "quoted", "confirmed", "completed", "cancelled"]);

export const deals = pgTable("deals", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  status: dealStatusEnum("status").notNull().default("open"),
  // Bumped every time a whatsapp_message is matched to this deal — the
  // matching algorithm's tie-break signal (packages/core/src/deals) and the
  // "was this deal touched recently" signal the reopen-a-recently-closed-deal
  // rule reads. Never derived from transfer_requests.updated_at (a deal can
  // receive a message that doesn't touch its current transfer_request at
  // all — a pure payment-method question, for instance).
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  // Deliberately NOT "paid"/"payment_verified"/anything that implies a
  // confirmed transaction — this records only that a customer's message
  // claimed a payment, for a human to reconcile. See
  // packages/core/src/deals/README.md's "Payments" section for why no
  // payment/billing logic reads or trusts this field automatically.
  customerReportedPaymentNote: text("customer_reported_payment_note"),
  customerReportedPaymentAt: timestamp("customer_reported_payment_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Deal = typeof deals.$inferSelect;
export type NewDeal = typeof deals.$inferInsert;
