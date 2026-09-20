import { pgTable, uuid, text, timestamp, jsonb, pgEnum, unique, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { clients } from "./clients";
import { deals } from "./deals";
import { transferRequests } from "./transfer-requests";
import { quotes } from "./quotes";
import { bookings } from "./bookings";
import { profiles } from "./profiles";

// BOS Agent — Phase 3: Approval -> Execution -> Verification for outbound
// customer communications. One row per prepared message; the row itself
// carries its own full lifecycle (never a separate approval entity —
// unlike agent_approvals, a communication and its approval decision are
// 1:1, and this table needs domain-specific columns agent_approvals has
// no reason to carry: deal/transfer_request/quote/booking/client links,
// channel, provider, provider_message_id). See
// packages/core/src/communications/README.md for the full state machine
// and the founder's rule this exists to enforce: the BOS may prepare a
// communication, but never send one to a real customer before explicit
// approval.
export const communicationStatusEnum = pgEnum("communication_status", [
  "prepared",
  "pending_approval",
  "approved",
  "executed",
  "verified",
  "execution_failed",
  "rejected",
]);

export const communications = pgTable(
  "communications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // Every communication has a real, known recipient — never inferred,
    // never a placeholder.
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
    transferRequestId: uuid("transfer_request_id").references(() => transferRequests.id, { onDelete: "set null" }),
    quoteId: uuid("quote_id").references(() => quotes.id, { onDelete: "set null" }),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),
    // Plain text, not an enum — same "new values shouldn't cost a
    // migration" rationale agent_runs.agentName/toolName already follow.
    channel: text("channel").notNull(),
    action: text("action").notNull(),
    // Which logical BOS actor prepared this (e.g. "operations", "system",
    // an admin profile acting directly) — free text for the same reason
    // agent_runs.agentName is free text.
    agent: text("agent").notNull(),
    correlationId: text("correlation_id"),
    // Deterministic, derived from real ids only (e.g. "quote_offer:<quoteId>")
    // — never a random value, never a message counter. Unique per tenant:
    // the real, DB-level anti-duplication guarantee (stronger than
    // agent_approvals' own app-level-only idempotency check).
    idempotencyKey: text("idempotency_key").notNull(),
    // The prepared message itself: { to, body, templateName, ... } — built
    // once, from real data, and never re-derived at execution time (so an
    // approver is reviewing/approving exactly what will be sent).
    content: jsonb("content").notNull(),
    status: communicationStatusEnum("status").notNull().default("prepared"),
    // @bos/ai's evaluatePolicy() output, recorded verbatim at submission
    // time — never re-evaluated later, so an approval always reflects the
    // policy decision that was actually shown to the approver.
    policyDecision: jsonb("policy_decision"),
    approvedBy: uuid("approved_by").references(() => profiles.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    // Name of the OutboundProvider that actually ran (e.g. "not_configured")
    // — never invented, never assumed; see communications/provider.ts.
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdempotencyKeyUnique: unique("communications_tenant_idempotency_key_unique").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    tenantDealIdx: index("communications_tenant_deal_idx").on(table.tenantId, table.dealId),
    tenantStatusIdx: index("communications_tenant_status_idx").on(table.tenantId, table.status),
  }),
);

export type Communication = typeof communications.$inferSelect;
export type NewCommunication = typeof communications.$inferInsert;
