import { z } from "zod";

// ── Founder-confirmed constants ──────────────────────────────────────────
// Same convention as pricing/service.ts's TOLL_RATE_PER_KM/MINIMUM_FARE_CENTS:
// a commercial-policy constant lives inside the engine, not as a parameter
// a caller can silently override — it's included in every result so an
// admin can see what was applied, but it is never an input.

// The only hardcoded location this module ever uses — the vehicle's base
// when there is no previous service to derive a real position from. Not a
// special case in the formula (see service.ts): it is simply the
// `previousService: null` origin, exactly like any other origin string.
export const BASE_LOCATION = "Sondrio";

export const OPERATIONAL_BUFFER_MINUTES = 60;

// ── Inputs ────────────────────────────────────────────────────────────────
// This module never calls Google Maps and never invents a duration —
// every *DurationMinutes value below is computed by the caller (via
// packages/core/src/maps-distance) and handed in already resolved.

// resourceId is deliberately optional and unused by every function in this
// module today (BOS operates a single vehicle/driver) — carried through
// purely so a future multi-vehicle version can filter "the previous
// service for THIS resource" before calling this same engine, without
// reshaping these types or touching the core formula.
export const previousServiceSchema = z.object({
  startAt: z.date(),
  pickup: z.string().trim().min(1),
  destination: z.string().trim().min(1),
  // pickup -> destination duration for THIS (already happened/scheduled)
  // service — never to be confused with the relocation duration below,
  // which is a different origin/destination pair entirely.
  customerTripDurationMinutes: z.number().finite().nonnegative(),
  resourceId: z.string().optional(),
});
export type PreviousService = z.infer<typeof previousServiceSchema>;

export const candidateServiceSchema = z.object({
  startAt: z.date(),
  pickup: z.string().trim().min(1),
  destination: z.string().trim().min(1),
  resourceId: z.string().optional(),
});
export type CandidateService = z.infer<typeof candidateServiceSchema>;

export const feasibilityCheckInputSchema = z.object({
  candidate: candidateServiceSchema,
  previousService: previousServiceSchema.nullable(),
  // Maps(relocationOrigin -> candidate.pickup), where relocationOrigin is
  // determineRelocationOrigin(previousService) — see service.ts. Required
  // whenever previousService is not null; ignored (and not required) when
  // it is null, since there is then no prior position to relocate from.
  relocationDurationMinutes: z.number().finite().nonnegative().optional(),
});
export type FeasibilityCheckInput = z.infer<typeof feasibilityCheckInputSchema>;

export const vehicleFreeEstimateInputSchema = z.object({
  candidate: candidateServiceSchema,
  // candidate.pickup -> candidate.destination duration.
  customerTripDurationMinutes: z.number().finite().nonnegative(),
  // candidate.destination -> BASE_LOCATION duration.
  returnToBaseDurationMinutes: z.number().finite().nonnegative(),
});
export type VehicleFreeEstimateInput = z.infer<typeof vehicleFreeEstimateInputSchema>;

// ── Outputs ───────────────────────────────────────────────────────────────
// Typed, structured results — never free text as the sole source of truth.
// `reason` is a closed union, not a string an admin has to parse.

export const feasibilityReasonSchema = z.enum([
  // feasible = true: no previous service exists, so nothing constrains the
  // vehicle from a prior job — it is treated as available from BASE_LOCATION.
  "no_previous_service",
  // feasible = true: vehicleReadyAt <= candidate.startAt.
  "within_operational_margin",
  // feasible = false: vehicleReadyAt > candidate.startAt.
  "insufficient_operational_margin",
]);
export type FeasibilityReason = z.infer<typeof feasibilityReasonSchema>;

export interface ServiceFeasibilityResult {
  feasible: boolean;
  reason: FeasibilityReason;
  candidateStartAt: Date;
  candidatePickup: string;
  candidateDestination: string;
  // The PREVIOUS service's customerTripDurationMinutes (the value that
  // determined when the vehicle finished its prior job) — null when there
  // is no previous service, never the candidate's own (unknown) trip
  // duration, which this function never needs.
  customerTripDurationMinutes: number | null;
  // Null only when there is no previous service (nothing to relocate from).
  vehicleRelocationDurationMinutes: number | null;
  operationalBufferMinutes: number;
  // Null only when there is no previous service — there is then no
  // computed constraint to report.
  vehicleReadyAt: Date | null;
  // Null only when there is no previous service, for the same reason.
  marginMinutes: number | null;
}

export interface VehicleFreeEstimateResult {
  serviceEndAt: Date;
  returnToBaseDurationMinutes: number;
  operationalBufferMinutes: number;
  estimatedVehicleFreeAt: Date;
}
