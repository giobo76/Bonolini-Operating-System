import { pgTable, uuid, text, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { clients } from "./clients";
import { quotes } from "./quotes";

// Minimal skeleton — status + money + client link only. No dispatch, driver
// assignment, or calendar logic (that's the real Booking Management feature,
// still to come per the roadmap). This table is meant to grow into that
// feature, not be replaced by it — built now so the marketing funnel has
// real confirmed-booking/completed-service/invoice/payment data to
// attribute against.
export const bookingStatusEnum = pgEnum("booking_status", [
  "confirmed",
  "completed",
  "cancelled",
]);

export const bookings = pgTable("bookings", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  quoteId: uuid("quote_id").references(() => quotes.id, { onDelete: "set null" }),
  status: bookingStatusEnum("status").notNull().default("confirmed"),
  currency: text("currency").notNull().default("EUR"),
  depositAmountCents: integer("deposit_amount_cents"),
  depositPaidAt: timestamp("deposit_paid_at", { withTimezone: true }),
  finalAmountCents: integer("final_amount_cents"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  // Invoice/payment fields flattened onto bookings for now rather than
  // separate invoices/payments tables — enough for funnel attribution
  // (was this booking invoiced/paid, for how much, when) without building
  // the full Invoicing/Payments features ahead of their turn on the roadmap.
  invoicedAt: timestamp("invoiced_at", { withTimezone: true }),
  invoiceAmountCents: integer("invoice_amount_cents"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  paidAmountCents: integer("paid_amount_cents"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
