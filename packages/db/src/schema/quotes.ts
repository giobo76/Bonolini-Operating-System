import { pgTable, uuid, text, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { clients } from "./clients";
import { deals } from "./deals";

// Minimal skeleton — status + money + client link only. This is the real
// foundation of the future Pricing & Quotes feature (rate-card computation,
// service-type-specific pricing, etc. arrive when that feature is
// properly built), not a throwaway table. Built now so the marketing
// funnel (Click → Lead → Quote → ...) has real data to attribute against.
export const quoteStatusEnum = pgEnum("quote_status", [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
]);

export const quotes = pgTable("quotes", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  // Phase 2.5 — links a quote back to the persistent negotiation it came
  // from. Nullable: pre-Phase-2.5 quotes (created manually via the admin
  // UI, see apps/transfer-admin/app/customers/[id]/actions.ts) have no deal
  // to backfill against (quotes carries no transfer_request_id to join
  // through) and are deliberately left null rather than guessed. See
  // packages/core/src/deals/README.md's "Quotes" section.
  dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
  status: quoteStatusEnum("status").notNull().default("draft"),
  // Smallest currency unit (cents), never a float — see docs/engineering/02-coding-standards.md.
  amountCents: integer("amount_cents"),
  currency: text("currency").notNull().default("EUR"),
  notes: text("notes"),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Quote = typeof quotes.$inferSelect;
export type NewQuote = typeof quotes.$inferInsert;
