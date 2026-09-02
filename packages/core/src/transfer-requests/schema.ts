import { z } from "zod";
import type { ServiceFeasibilityResult } from "../availability";

export const transferRequestStatusSchema = z.enum([
  "collecting_info",
  "ready_for_pricing",
  "pending_admin_approval",
  "approved",
  "converted_to_quote",
  "cancelled",
  "expired",
]);

export const transferRequestPricingStatusSchema = z.enum([
  "not_priced",
  "fixed",
  "calculated_km",
  "manual_required",
]);

// The subset of a WhatsApp-parsed message relevant to a transfer request.
// Deliberately its own shape, not a re-export of the whatsapp module's
// ParsedWhatsappMessage — keeps this module decoupled from the whatsapp
// module's parser internals per ADR 0002 (cross-module access only through
// each module's index.ts, and only for what's actually needed here).
// Mapping ParsedWhatsappMessage -> this shape is the caller's job, not
// this module's.
export const transferRequestExtractedFieldsSchema = z.object({
  intent: z.string().trim().min(1).optional(),
  pickup: z.string().trim().min(1).optional(),
  destination: z.string().trim().min(1).optional(),
  date: z.string().trim().min(1).optional(),
  time: z.string().trim().min(1).optional(),
  passengers: z.number().int().positive().optional(),
  luggage: z.string().trim().min(1).optional(),
  flight: z.string().trim().min(1).optional(),
  train: z.string().trim().min(1).optional(),
  hotel: z.string().trim().min(1).optional(),
  language: z.string().trim().min(1).optional(),
});

export type TransferRequestExtractedFields = z.infer<typeof transferRequestExtractedFieldsSchema>;

// ── Admin decision (accept / reject / modify price) ──────────────────────
// Input shapes for the three tRPC mutations in ./router.ts — kept here,
// colocated with the module's other schemas, per the project's folder
// conventions (validation lives next to the router it belongs to).

export const transferRequestIdSchema = z.object({ id: z.string().uuid() });

export const rejectTransferRequestSchema = z.object({
  id: z.string().uuid(),
  // Optional free-text note, appended to the fixed 'rejected_by_admin'
  // marker (never replaces it) so REJECT's idempotency check can still
  // recognize "this was already rejected by an admin" regardless of what
  // note, if any, was given. See service.ts::rejectTransferRequest.
  reason: z.string().trim().min(1).optional(),
});

export const modifyPriceForTransferRequestSchema = z.object({
  id: z.string().uuid(),
  amountCents: z.number().int().positive(),
  // Required, never empty — mirrors the `reason` already documented for
  // bookings.overridePrice in docs/domain/13-api-contracts.md.
  reason: z.string().trim().min(1),
});

// ── Availability breakdown (persisted onto transfer_requests.availability_breakdown) ──
// Symmetric to how pricingBreakdown wraps the pricing engine's own typed
// output plus Maps-call metadata (see runPricingForTransferRequest's
// `distanceLookup`) — never inventing new field names for the feasibility
// decision itself: `feasibility` below is availability's own
// ServiceFeasibilityResult, used verbatim (Core v1 types, not
// reimplemented here). `customerTripDuration`/`relocation` and
// `previousServiceEndAt` are orchestration-level context the pure
// availability module deliberately doesn't compute itself (it never calls
// Maps) — added here, one layer up, exactly where distanceLookup already
// lives for pricing.

export interface MapsDurationLookup {
  status: "ok" | "error";
  durationMinutes: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface AvailabilityRelocationLookup {
  // "not_applicable" when there is no previous service to relocate from
  // (previousService === null) — relocationOrigin is then BASE_LOCATION
  // ("Sondrio") but no Maps call is made, because isServiceFeasible
  // doesn't need one in that case (see availability/service.ts).
  status: "ok" | "error" | "not_applicable";
  origin: string | null;
  durationMinutes: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

// Dates serialized to ISO strings for jsonb storage — never a raw JS Date
// object into a jsonb column (same discipline this codebase already
// applies elsewhere after the earlier Date-serialization incident; see
// transfer-requests/service.ts's own history comment).
export type SerializedServiceFeasibilityResult = Omit<
  ServiceFeasibilityResult,
  "candidateStartAt" | "vehicleReadyAt"
> & {
  candidateStartAt: string;
  vehicleReadyAt: string | null;
};

export interface AvailabilityBreakdown {
  // "verified": isServiceFeasible actually ran and produced a real
  // decision (feasible true or false — both count as "verified"; a real
  // answer was computed). "not_verified": a required Maps call (relocation,
  // when a previous service exists) failed, so no feasible/infeasible
  // decision could be honestly produced — feasibility is then null, never
  // guessed.
  status: "verified" | "not_verified";
  customerTripDuration: MapsDurationLookup;
  relocation: AvailabilityRelocationLookup;
  // ISO string, or null only when there is no previous service.
  previousServiceEndAt: string | null;
  feasibility: SerializedServiceFeasibilityResult | null;
}
