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

// ── Foreign Lake Como <-> Tirano commercial fixed fares ────────────────
// Founder-approved public price list for the English/foreign-facing site
// pages (2026-08-31), up to 4 passengers, identical in both directions.
// Deliberately checked BEFORE isComoTiranoRoute/findFixedFareCategory
// below: without this, "Tirano -> Milano"/"Tirano -> Malpensa" would hit
// the existing airport fixed-fare table's isOriginCompatibleWithFixedFare
// check, see "Tirano" as an unrecognized pickup, and defer to
// manual_required — an asymmetry versus "Milano/Malpensa -> Tirano" (which
// falls through to generic_km) that would make the same named route price
// differently, or not at all, depending on direction. Intercepting here
// guarantees the five routes below are identical in both directions, per
// the explicit commercial requirement.
type ForeignFixedTiranoRoute = "varenna" | "menaggio" | "como" | "milan" | "malpensa";

const FOREIGN_FIXED_TIRANO_FARE_CENTS: Record<ForeignFixedTiranoRoute, number> = {
  varenna: 26000, // €260
  menaggio: 30000, // €300
  como: 36000, // €360 — same figure as the pre-existing COMO_TIRANO_FOREIGN_FIXED_CENTS below; this table is now its single source
  milan: 39000, // €390
  malpensa: 44000, // €440
};

const FOREIGN_FIXED_TIRANO_MATCHED_RULE: Record<ForeignFixedTiranoRoute, MatchedRule> = {
  varenna: "varenna_tirano_fixed_foreign",
  menaggio: "menaggio_tirano_fixed_foreign",
  como: "como_tirano_fixed_foreign", // unchanged rule name — same route, same price as before this change
  milan: "milan_tirano_fixed_foreign",
  malpensa: "malpensa_tirano_fixed_foreign",
};

// Whole-word (not raw substring) matching for the new logic added here —
// avoids the false-positive risk a bare .includes() carries (e.g. a place
// name that happens to contain "milan" or "como" as a fragment of a longer,
// unrelated word). Deliberately NOT applied to isComoTiranoRoute/
// findFixedFareCategory further down: those are pre-existing, already
// live, already relied on by maps-distance's route-convention selection —
// changing their matching semantics is out of scope here and risks an
// unrelated regression. "Milan"/"Milano" and "Malpensa"/"MXP" cover the
// English and Italian spellings a customer or admin might type.
const FOREIGN_FIXED_TIRANO_KEYWORDS: Record<ForeignFixedTiranoRoute, RegExp> = {
  varenna: /\bvarenna\b/i,
  menaggio: /\bmenaggio\b/i,
  como: /\bcomo\b/i,
  milan: /\bmilan(?:o)?\b/i,
  malpensa: /\bmalpensa\b|\bmxp\b/i,
};

// Iteration order matters only in that it's deterministic — no two keyword
// patterns above can simultaneously match the same real place name.
const FOREIGN_FIXED_TIRANO_ROUTES = Object.keys(FOREIGN_FIXED_TIRANO_KEYWORDS) as ForeignFixedTiranoRoute[];

function matchForeignFixedTiranoRoute(pickup: string, destination: string): ForeignFixedTiranoRoute | null {
  const combined = `${pickup} ${destination}`.toLowerCase();
  if (!/\btirano\b/i.test(combined)) return null;
  for (const route of FOREIGN_FIXED_TIRANO_ROUTES) {
    if (FOREIGN_FIXED_TIRANO_KEYWORDS[route].test(combined)) return route;
  }
  return null;
}

// Known Lake Como towns/areas with real, recurring customer interest but
// deliberately NO published fixed fare (commercial decision, not a data
// gap) — always defer to manual_required for a foreign customer instead of
// silently falling through to generic_km. NOT an exhaustive list of every
// hamlet on the lake (a true "is this address on Lake Como" check would
// need real geocoding, out of scope here) — covers the towns the founder
// named explicitly (Bellagio, Tremezzo) plus the other most commonly
// requested ones, so genuinely obscure locations still fall through to
// generic_km rather than being silently mis-served either way. Deliberately
// excludes "como"/"lake como"/"lago di como" themselves — those already
// resolve to the published Como fixed fare above, unchanged from before
// this change.
const OTHER_LAKE_COMO_KEYWORDS =
  /\bbellagio\b|\btremezzo\b|\bcernobbio\b|\bcadenabbia\b|\blenno\b|\blezzeno\b|\bmoltrasio\b|\btorno\b|\bargegno\b|\blaglio\b/i;

function isOtherLakeComoMention(pickup: string, destination: string): boolean {
  const combined = `${pickup} ${destination}`.toLowerCase();
  return /\btirano\b/i.test(combined) && OTHER_LAKE_COMO_KEYWORDS.test(combined);
}

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

  // Foreign Lake Como <-> Tirano commercial fixed fares — checked first,
  // ahead of every other branch, for exactly the reasons in the comment
  // above FOREIGN_FIXED_TIRANO_FARE_CENTS.
  if (input.customerType === "foreign") {
    const namedRoute = matchForeignFixedTiranoRoute(input.pickup, input.destination);
    if (namedRoute) {
      if (input.passengers > 4) {
        return buildManualRequired(input.customerType, "passengers_above_supported_fare_band", hospitalWaiting);
      }
      return buildFixedResult(
        input.customerType,
        FOREIGN_FIXED_TIRANO_FARE_CENTS[namedRoute],
        FOREIGN_FIXED_TIRANO_MATCHED_RULE[namedRoute],
        hospitalWaiting,
      );
    }

    if (isOtherLakeComoMention(input.pickup, input.destination)) {
      return buildManualRequired(input.customerType, "lake_como_location_requires_personalized_quote", hospitalWaiting);
    }
  }

  if (isComoTiranoRoute(input.pickup, input.destination)) {
    // customerType is always "italian" by the time execution reaches here —
    // a foreign customer on this same route was already resolved above by
    // the named fixed-fare branch (matchForeignFixedTiranoRoute's "como"
    // keyword matches whenever isComoTiranoRoute does, for a foreign
    // customer, so that branch never falls through to this one).
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
