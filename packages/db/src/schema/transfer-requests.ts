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
  // second enum, to avoid multiplying status values (see README.md). Also
  // used for an admin REJECT decision (value 'rejected_by_admin', or
  // 'rejected_by_admin: <note>') — reusing this field rather than adding a
  // 'rejected' status, per the founder-approved admin-decision design (see
  // README.md's "Admin decision" section).
  cancelledReason: text("cancelled_reason"),
  // The pricing engine's output (calculatedAmountCents) is never what gets
  // approved verbatim — this is. Set atomically together with the
  // pending_admin_approval -> approved transition (ACCEPT or MODIFY_PRICE),
  // never in a separate step; null until an admin has decided. Every future
  // consumer that represents the actually-approved service (quote, booking,
  // calendar event) must read this column, never calculatedAmountCents —
  // see README.md's "Admin decision" section for the full rationale.
  finalAmountCents: integer("final_amount_cents"),
  // Non-null only when finalAmountCents came from MODIFY_PRICE (an admin
  // override), null on a plain ACCEPT — its presence alone distinguishes
  // "approved as computed" from "approved at an admin-chosen price", no
  // separate boolean needed. Mirrors the `reason` input already documented
  // for bookings.overridePrice in docs/domain/13-api-contracts.md.
  priceOverrideReason: text("price_override_reason"),
  // One-way pickup -> destination drive time in minutes, from
  // packages/core/src/maps-distance's calculateRoute([pickup, destination])
  // — never the round-trip total pricingBreakdown.distanceLookup carries
  // (a different, Sondrio-anchored convention pricing needs, structurally
  // the wrong shape for this column). Null until the Availability
  // connection successfully resolves it; feeds the future Booking Snapshot
  // milestone's bookings.customer_trip_duration_minutes directly. See
  // packages/core/src/transfer-requests/README.md's "Availability" section.
  customerTripDurationMinutes: integer("customer_trip_duration_minutes"),
  // Structured, admin-explainable Availability result — symmetric to
  // pricingBreakdown. Never blocks status progression to
  // pending_admin_approval; see AvailabilityBreakdown in
  // packages/core/src/transfer-requests/schema.ts for the exact shape.
  availabilityBreakdown: jsonb("availability_breakdown"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TransferRequest = typeof transferRequests.$inferSelect;
export type NewTransferRequest = typeof transferRequests.$inferInsert;
