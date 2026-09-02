import { BASE_LOCATION, OPERATIONAL_BUFFER_MINUTES } from "./schema";
import type {
  CandidateService,
  FeasibilityCheckInput,
  PreviousService,
  ServiceFeasibilityResult,
  VehicleFreeEstimateInput,
  VehicleFreeEstimateResult,
} from "./schema";

// ── Core Availability Engine v1 — pure, no I/O ───────────────────────────
// No Google Calendar, no Google Maps, no database access anywhere in this
// module. Every duration (customerTripDurationMinutes,
// relocationDurationMinutes, returnToBaseDurationMinutes) is computed
// externally (by a future caller, via packages/core/src/maps-distance —
// never duplicated here) and handed in already resolved. This module's
// only job is the arithmetic and the feasibility decision — see README.md
// for the full rationale and the CChiefGrowthAI audit this recovers from
// (in short: nothing — no working version of this logic existed anywhere
// in the old project).

function assertFiniteNonNegative(value: number, label: string, caller: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${caller}: ${label} must be a finite, non-negative number (got ${value})`);
  }
}

function assertNonEmpty(value: string, label: string, caller: string): void {
  if (!value || !value.trim()) {
    throw new Error(`${caller}: ${label} must not be empty`);
  }
}

function assertValidCandidate(candidate: CandidateService, caller: string): void {
  assertNonEmpty(candidate.pickup, "candidate.pickup", caller);
  assertNonEmpty(candidate.destination, "candidate.destination", caller);
  if (Number.isNaN(candidate.startAt.getTime())) {
    throw new Error(`${caller}: candidate.startAt is not a valid Date`);
  }
}

function assertValidPreviousService(previousService: PreviousService, caller: string): void {
  assertNonEmpty(previousService.pickup, "previousService.pickup", caller);
  assertNonEmpty(previousService.destination, "previousService.destination", caller);
  if (Number.isNaN(previousService.startAt.getTime())) {
    throw new Error(`${caller}: previousService.startAt is not a valid Date`);
  }
  assertFiniteNonNegative(
    previousService.customerTripDurationMinutes,
    "previousService.customerTripDurationMinutes",
    caller,
  );
}

// The one location this module ever hardcodes — and only as the origin
// used when previousService is null, never as a branch in the feasibility
// formula itself (see isServiceFeasible/estimateVehicleFreeAt: neither
// contains an `if` on any place name). Exported so a future caller can
// decide what to pass into a Maps distance lookup (Sondrio -> pickup, or
// previousService.destination -> pickup) without re-deriving this rule.
export function determineRelocationOrigin(previousService: PreviousService | null): string {
  return previousService ? previousService.destination : BASE_LOCATION;
}

// Pure date arithmetic, reused by both public entry points below — the
// only place "add a duration to a start time" is implemented, so
// isServiceFeasible and estimateVehicleFreeAt can never drift apart on it.
export function calculateServiceEndAt(startAt: Date, durationMinutes: number): Date {
  assertFiniteNonNegative(durationMinutes, "durationMinutes", "calculateServiceEndAt");
  if (Number.isNaN(startAt.getTime())) {
    throw new Error("calculateServiceEndAt: startAt is not a valid Date");
  }
  return new Date(startAt.getTime() + durationMinutes * 60_000);
}

// serviceEndAt + relocationDurationMinutes + operationalBufferMinutes.
// This single function IS the formula from both worked examples in the
// spec (Sondrio->Malpensa->Sondrio+buffer, and Aprica->Sondrio/Milano+buffer)
// — isServiceFeasible and estimateVehicleFreeAt only differ in which
// serviceEndAt and which relocation duration they feed into it.
export function calculateVehicleReadyAt(
  serviceEndAt: Date,
  relocationDurationMinutes: number,
  operationalBufferMinutes: number = OPERATIONAL_BUFFER_MINUTES,
): Date {
  assertFiniteNonNegative(relocationDurationMinutes, "relocationDurationMinutes", "calculateVehicleReadyAt");
  assertFiniteNonNegative(operationalBufferMinutes, "operationalBufferMinutes", "calculateVehicleReadyAt");
  if (Number.isNaN(serviceEndAt.getTime())) {
    throw new Error("calculateVehicleReadyAt: serviceEndAt is not a valid Date");
  }
  return new Date(serviceEndAt.getTime() + (relocationDurationMinutes + operationalBufferMinutes) * 60_000);
}

// The main entry point: is `candidate` feasible given what the vehicle was
// doing right before it (or nothing, if this is the first service)? Never
// branches on a place name — relocationOrigin (Sondrio or the previous
// destination) is entirely the caller's concern via determineRelocationOrigin
// and a real Maps lookup; this function only ever sees the resulting
// number.
export function isServiceFeasible(input: FeasibilityCheckInput): ServiceFeasibilityResult {
  const { candidate, previousService } = input;
  assertValidCandidate(candidate, "isServiceFeasible");

  if (!previousService) {
    // Nothing constrains the vehicle from a prior job — treated as
    // available from BASE_LOCATION, per the founder's explicit rule (see
    // README.md). Not a special-cased formula branch, just the honest
    // absence of a constraint to compute.
    return {
      feasible: true,
      reason: "no_previous_service",
      candidateStartAt: candidate.startAt,
      candidatePickup: candidate.pickup,
      candidateDestination: candidate.destination,
      customerTripDurationMinutes: null,
      vehicleRelocationDurationMinutes: null,
      operationalBufferMinutes: OPERATIONAL_BUFFER_MINUTES,
      vehicleReadyAt: null,
      marginMinutes: null,
    };
  }

  assertValidPreviousService(previousService, "isServiceFeasible");
  if (input.relocationDurationMinutes === undefined) {
    throw new Error("isServiceFeasible: relocationDurationMinutes is required when previousService is provided");
  }
  assertFiniteNonNegative(input.relocationDurationMinutes, "relocationDurationMinutes", "isServiceFeasible");

  const previousServiceEndAt = calculateServiceEndAt(
    previousService.startAt,
    previousService.customerTripDurationMinutes,
  );
  const vehicleReadyAt = calculateVehicleReadyAt(
    previousServiceEndAt,
    input.relocationDurationMinutes,
    OPERATIONAL_BUFFER_MINUTES,
  );
  const marginMinutes = Math.round((candidate.startAt.getTime() - vehicleReadyAt.getTime()) / 60_000);
  const feasible = vehicleReadyAt.getTime() <= candidate.startAt.getTime();

  return {
    feasible,
    reason: feasible ? "within_operational_margin" : "insufficient_operational_margin",
    candidateStartAt: candidate.startAt,
    candidatePickup: candidate.pickup,
    candidateDestination: candidate.destination,
    customerTripDurationMinutes: previousService.customerTripDurationMinutes,
    vehicleRelocationDurationMinutes: input.relocationDurationMinutes,
    operationalBufferMinutes: OPERATIONAL_BUFFER_MINUTES,
    vehicleReadyAt,
    marginMinutes,
  };
}

// Answers a different question than isServiceFeasible: not "is this
// specific candidate feasible", but "roughly when is the vehicle free
// again, in general, after this service, assuming it relocates back to
// base" — the Sondrio->Malpensa->Sondrio+buffer worked example. Reuses the
// exact same two primitives as isServiceFeasible (calculateServiceEndAt,
// calculateVehicleReadyAt) — never a second implementation of "add a
// duration", just a different pair of durations fed into it.
export function estimateVehicleFreeAt(input: VehicleFreeEstimateInput): VehicleFreeEstimateResult {
  assertValidCandidate(input.candidate, "estimateVehicleFreeAt");
  assertFiniteNonNegative(
    input.customerTripDurationMinutes,
    "customerTripDurationMinutes",
    "estimateVehicleFreeAt",
  );
  assertFiniteNonNegative(
    input.returnToBaseDurationMinutes,
    "returnToBaseDurationMinutes",
    "estimateVehicleFreeAt",
  );

  const serviceEndAt = calculateServiceEndAt(input.candidate.startAt, input.customerTripDurationMinutes);
  const estimatedVehicleFreeAt = calculateVehicleReadyAt(
    serviceEndAt,
    input.returnToBaseDurationMinutes,
    OPERATIONAL_BUFFER_MINUTES,
  );

  return {
    serviceEndAt,
    returnToBaseDurationMinutes: input.returnToBaseDurationMinutes,
    operationalBufferMinutes: OPERATIONAL_BUFFER_MINUTES,
    estimatedVehicleFreeAt,
  };
}
