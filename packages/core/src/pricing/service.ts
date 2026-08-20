import type {
  CustomerType,
  HospitalWaitingInfo,
  ManualRequiredReason,
  MatchedRule,
  PricingBreakdown,
  PricingInput,
  PricingResult,
} from "./schema";

// ── Constants recovered verbatim from CChiefGrowthAI's pricing_engine.py,
// confirmed by the founder — never reinterpreted. See README.md for the
// exact source lines each one came from.

const TOLL_RATE_PER_KM = 0.08;
const MINIMUM_FARE_CENTS = 5000;
const COMO_TIRANO_FOREIGN_FIXED_CENTS = 36000;

type FixedFareCategory = "linate_orio_citta" | "malpensa";

// Order matters for iteration below only in that every keyword must be
// checked — matching is "any keyword found", not first-match-wins on order.
const AIRPORT_FARE_CATEGORY: Record<string, FixedFareCategory> = {
  linate: "linate_orio_citta",
  "orio al serio": "linate_orio_citta",
  orio: "linate_orio_citta",
  bgy: "linate_orio_citta",
  bergamo: "linate_orio_citta",
  milano: "linate_orio_citta",
  malpensa: "malpensa",
  mxp: "malpensa",
};

const FIXED_FARE_TABLE_CENTS: Record<FixedFareCategory, Record<4 | 5 | 6 | 7 | 8, number>> = {
  linate_orio_citta: { 4: 22000, 5: 25000, 6: 28000, 7: 30000, 8: 32000 },
  malpensa: { 4: 25000, 5: 27000, 6: 29000, 7: 32000, 8: 35000 },
};

const HOSPITAL_KEYWORDS = ["ospedale", "hospital", "clinica", "pronto soccorso"];

export function determineCustomerType(phone: string): CustomerType {
  const cleaned = phone.replace(/^\+/, "");
  return cleaned.startsWith("39") ? "italian" : "foreign";
}

function kmRate(customerType: CustomerType, distanceKm: number): number {
  if (customerType === "foreign") {
    return distanceKm <= 100 ? 1.3 : 1.2;
  }
  return distanceKm <= 100 ? 1.0 : 0.85;
}

// Exported (only this one internal helper, deliberately) so the
// transfer-requests <-> maps-distance connection can ask "does this route
// need the Como-Tirano waypoint convention or the generic one?" without
// re-implementing this exact keyword check a second time. calculatePrice()
// itself remains the only place that decides whether a price/distance is
// actually needed — this just answers "which route is it", a fact, not a
// pricing decision.
export function isComoTiranoRoute(pickup: string, destination: string): boolean {
  const combined = `${pickup} ${destination}`.toLowerCase();
  return combined.includes("como") && combined.includes("tirano");
}

function findFixedFareCategory(destination: string): FixedFareCategory | null {
  const normalized = destination.toLowerCase();
  for (const [keyword, category] of Object.entries(AIRPORT_FARE_CATEGORY)) {
    if (normalized.includes(keyword)) return category;
  }
  return null;
}

// Mirrors CChiefGrowthAI's partenza_non_sondrio exclusion exactly: pickup
// is "compatible" if it's Sondrio itself, or already one of the known
// fixed-fare keywords (a "return" leg from the airport/city itself).
function isOriginCompatibleWithFixedFare(pickup: string): boolean {
  const normalized = pickup.toLowerCase();
  if (normalized.includes("sondrio")) return true;
  return Object.keys(AIRPORT_FARE_CATEGORY).some((keyword) => normalized.includes(keyword));
}

function fixedFareForPassengers(category: FixedFareCategory, passengers: number): number {
  const tiers = [4, 5, 6, 7, 8] as const;
  for (const tier of tiers) {
    if (passengers <= tier) return FIXED_FARE_TABLE_CENTS[category][tier];
  }
  // Unreachable: callers only reach here after confirming passengers <= 8.
  return FIXED_FARE_TABLE_CENTS[category][8];
}

// Hospital detection is cross-cutting — evaluated once, independent of
// which pricing branch the base transfer takes. Fixes the gap found in
// CChiefGrowthAI's own code, where the equivalent check only ever fired
// inside the fixed-fare branch, never on a km-calculated destination
// (e.g. "Ospedale di Sondalo", CChiefGrowthAI's own test example).
function evaluateHospitalWaiting(destination: string, customerType: CustomerType): HospitalWaitingInfo {
  const applies = HOSPITAL_KEYWORDS.some((keyword) => destination.toLowerCase().includes(keyword));

  if (!applies) {
    return { applies: false, hospitalWaitingStatus: "not_applicable", hospitalWaitingRule: null, freeMinutes: null, ratePerHourCents: null };
  }

  if (customerType === "italian") {
    return {
      applies: true,
      hospitalWaitingStatus: "defined",
      hospitalWaitingRule: "1h_free_then_40_eur_per_hour",
      freeMinutes: 60,
      ratePerHourCents: 4000,
    };
  }

  // Foreign: rule not yet defined — never guessed, never defaulted to the
  // italian rate.
  return { applies: true, hospitalWaitingStatus: "manual_required", hospitalWaitingRule: null, freeMinutes: null, ratePerHourCents: null };
}

function buildManualRequired(
  customerType: CustomerType,
  reason: ManualRequiredReason,
  hospitalWaiting: HospitalWaitingInfo,
  breakdownOverrides: Partial<PricingBreakdown> = {},
): PricingResult {
  return {
    pricingStatus: "manual_required",
    customerType,
    serviceType: "point_to_point",
    baseAmountCents: null,
    tollAmountCents: null,
    adjustments: [],
    finalAmountCents: null,
    currency: "EUR",
    manualRequiredReason: reason,
    hospitalWaiting,
    pricingBreakdown: {
      matchedRule: "manual_required",
      distanceKmUsed: null,
      ratePerKmApplied: null,
      fixedFareApplied: null,
      tollEstimateCents: null,
      minimumFareCents: MINIMUM_FARE_CENTS,
      minimumFareApplied: false,
      manualRequiredReason: reason,
      warnings: [],
      ...breakdownOverrides,
    },
  };
}

function buildFixedResult(
  customerType: CustomerType,
  fareCents: number,
  matchedRule: MatchedRule,
  hospitalWaiting: HospitalWaitingInfo,
): PricingResult {
  return {
    pricingStatus: "fixed",
    customerType,
    serviceType: "point_to_point",
    baseAmountCents: fareCents,
    tollAmountCents: null,
    adjustments: [],
    finalAmountCents: fareCents,
    currency: "EUR",
    manualRequiredReason: null,
    hospitalWaiting,
    pricingBreakdown: {
      matchedRule,
      distanceKmUsed: null,
      ratePerKmApplied: null,
      fixedFareApplied: fareCents,
      tollEstimateCents: null,
      minimumFareCents: MINIMUM_FARE_CENTS,
      minimumFareApplied: false,
      manualRequiredReason: null,
      warnings: [],
    },
  };
}

// Each *Cents component is rounded once, at the point it becomes a real
// breakdown field the admin can read (base, toll) — not deferred to a
// single end-of-chain rounding the way CChiefGrowthAI's euro-only
// calculation did. finalAmountCents is then an exact integer sum of
// already-rounded cents, so no further rounding error is introduced.
function buildKmResult(
  customerType: CustomerType,
  distanceKm: number,
  matchedRule: MatchedRule,
  hospitalWaiting: HospitalWaitingInfo,
): PricingResult {
  const rate = kmRate(customerType, distanceKm);
  const baseAmountCents = Math.round(distanceKm * rate * 100);
  const tollAmountCents = Math.round(distanceKm * TOLL_RATE_PER_KM * 100);
  const computedTotalCents = baseAmountCents + tollAmountCents;
  const minimumFareApplied = computedTotalCents < MINIMUM_FARE_CENTS;
  const finalAmountCents = Math.max(computedTotalCents, MINIMUM_FARE_CENTS);

  return {
    pricingStatus: "calculated_km",
    customerType,
    serviceType: "point_to_point",
    baseAmountCents,
    tollAmountCents,
    adjustments: [],
    finalAmountCents,
    currency: "EUR",
    manualRequiredReason: null,
    hospitalWaiting,
    pricingBreakdown: {
      matchedRule,
      distanceKmUsed: distanceKm,
      ratePerKmApplied: rate,
      fixedFareApplied: null,
      tollEstimateCents: tollAmountCents,
      minimumFareCents: MINIMUM_FARE_CENTS,
      minimumFareApplied,
      manualRequiredReason: null,
      warnings: [],
    },
  };
}

// The single entry point. Pure — no DB, no network, no side effects.
// Never throws on business-shape issues (missing passengers, missing
// distance): every such case resolves to a manual_required PricingResult
// instead, per the "conservative engine, never guess" mandate.
export function calculatePrice(input: PricingInput): PricingResult {
  const hospitalWaiting = evaluateHospitalWaiting(input.destination, input.customerType);

  // Intake signals that immediately defer — see schema.ts's comment on why
  // these fields exist. None of them compute a price; they only let the
  // engine recognize a case it must not guess at.
  if (input.requestedServiceType === "hourly") {
    return buildManualRequired(input.customerType, "hourly_formula_not_defined", hospitalWaiting);
  }
  if (input.channel === "gettransfer") {
    return buildManualRequired(input.customerType, "gettransfer_base_tariff_not_defined", hospitalWaiting);
  }
  if (input.channel === "viator") {
    return buildManualRequired(input.customerType, "viator_external_price_not_provided", hospitalWaiting);
  }
  if (input.possibleNightOrHolidaySurcharge && input.customerType === "foreign") {
    return buildManualRequired(input.customerType, "night_holiday_surcharge_requires_admin_decision", hospitalWaiting);
  }

  if (!Number.isInteger(input.passengers) || input.passengers <= 0) {
    return buildManualRequired(input.customerType, "passengers_missing", hospitalWaiting);
  }

  if (isComoTiranoRoute(input.pickup, input.destination)) {
    if (input.customerType === "foreign") {
      return buildFixedResult(input.customerType, COMO_TIRANO_FOREIGN_FIXED_CENTS, "como_tirano_fixed_foreign", hospitalWaiting);
    }
    if (input.distanceKm === undefined) {
      return buildManualRequired(input.customerType, "distance_not_provided", hospitalWaiting);
    }
    return buildKmResult(input.customerType, input.distanceKm, "como_tirano_km_italian", hospitalWaiting);
  }

  const fixedCategory = findFixedFareCategory(input.destination);
  if (fixedCategory) {
    if (input.passengers > 8) {
      return buildManualRequired(input.customerType, "passengers_above_supported_fare_band", hospitalWaiting);
    }
    if (!isOriginCompatibleWithFixedFare(input.pickup)) {
      return buildManualRequired(input.customerType, "fixed_fare_origin_requires_verification", hospitalWaiting, {
        warnings: ["Pickup location is not Sondrio or a known fixed-fare location — fixed fare cannot be applied automatically."],
      });
    }
    const fareCents = fixedFareForPassengers(fixedCategory, input.passengers);
    const matchedRule: MatchedRule = fixedCategory === "malpensa" ? "fixed_airport_malpensa" : "fixed_airport_linate_orio_city";
    return buildFixedResult(input.customerType, fareCents, matchedRule, hospitalWaiting);
  }

  if (input.distanceKm === undefined) {
    return buildManualRequired(input.customerType, "distance_not_provided", hospitalWaiting);
  }
  return buildKmResult(input.customerType, input.distanceKm, "generic_km", hospitalWaiting);
}
