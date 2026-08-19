import { pgTable, uuid, text, integer, date, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { clients } from "./clients";
import { quotes } from "./quotes";
import { profiles } from "./profiles";

// ── Transfer request — current normalized commercial request ────────────
// Sits between whatsapp_messages (immutable per-message log) and quotes
// (official, frozen preventivo snapshot). One row per in-progress request;
// see packages/core/src/transfer-requests/README.md for the full lifecycle
// and the matching/merge rules that populate it.

export const transferRequestStatusEnum = pgEnum("transfer_request_status", [
  "collecting_info",
  "ready_for_pricing",
  "pending_admin_approval",
  "approved",
  "converted_to_quote",
  "cancelled",
  "expired",
]);

// Deliberately separate from `status` — this is the outcome of the (not yet
// built) pricing engine, orthogonal to the workflow stage. No "priced"
// workflow status exists on purpose: pricing_status alone carries that
// information once the engine runs.
export const transferRequestPricingStatusEnum = pgEnum("transfer_request_pricing_status", [
  "not_priced",
  "fixed",
  "calculated_km",
  "manual_required",
]);

export const transferRequests = pgTable("transfer_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  status: transferRequestStatusEnum("status").notNull().default("collecting_info"),
  intent: text("intent"),
  pickup: text("pickup"),
  pickupAddress: text("pickup_address"),
  destination: text("destination"),
  destinationAddress: text("destination_address"),
  // Plain date (no time zone) — a calendar date the customer asked for, not
  // an instant. Mode "string" keeps it as "YYYY-MM-DD", matching the ISO
  // date string the WhatsApp parser already produces.
  requestedDate: date("requested_date", { mode: "string" }),
  requestedTime: text("requested_time"),
  passengers: integer("passengers"),
  luggage: text("luggage"),
  flightNumber: text("flight_number"),
  trainNumber: text("train_number"),
  hotel: text("hotel"),
  language: text("language"),
  // Recomputed from the current merged state on every update — never
  // accumulated from per-message missingInformation arrays, which go stale
  // the moment new info arrives. See computeMissingInformation() in
  // packages/core/src/transfer-requests/service.ts.
  missingInformation: text("missing_information").array(),
  pricingStatus: transferRequestPricingStatusEnum("pricing_status").notNull().default("not_priced"),
  calculatedAmountCents: integer("calculated_amount_cents"),
  currency: text("currency").notNull().default("EUR"),
  pricingBreakdown: jsonb("pricing_breakdown"),
  // Populated only when the request is promoted to an official quote — see
  // README.md's "quote transition". Never set before status=approved.
  quoteId: uuid("quote_id").references(() => quotes.id, { onDelete: "set null" }),
  adminApprovedAt: timestamp("admin_approved_at", { withTimezone: true }),
  adminApprovedBy: uuid("admin_approved_by").references(() => profiles.id, { onDelete: "set null" }),
  // Only meaningful when status = 'cancelled' — free text rather than a
  // second enum, to avoid multiplying status values (see README.md).
  cancelledReason: text("cancelled_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TransferRequest = typeof transferRequests.$inferSelect;
export type NewTransferRequest = typeof transferRequests.$inferInsert;
