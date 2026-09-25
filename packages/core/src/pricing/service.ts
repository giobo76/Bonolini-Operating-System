import { DEFAULT_PRICING_RATES } from "./schema";
import { isMalpensa, isSondrioCity } from "../locations";
import type {
  CustomerType,
  HospitalWaitingInfo,
  ManualRequiredReason,
  PassengerTierRates,
  MatchedRule,
  PricingBreakdown,
  PricingInput,
  PricingRates,
  PricingResult,
} from "./schema";

// ── Route/destination classification — pure keyword matching, never a
// commercial value, so none of this became a Business Rule in Phase 2 (see
// schema.ts's "Business Rules content shapes" comment for the exact line
// between "value" and "classification"). Unchanged from before Phase 2.

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

function kmRate(customerType: CustomerType, distanceKm: number, distanceRate: PricingRates["distanceRate"]): number {
  if (customerType === "foreign") {
    return distanceKm <= 100 ? distanceRate.foreignUpTo100Km : distanceRate.foreignAbove100Km;
  }
  return distanceKm <= 100 ? distanceRate.italianUpTo100Km : distanceRate.italianAbove100Km;
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

function fixedFareForPassengers(
  category: FixedFareCategory,
  passengers: number,
  fixedFareAirport: PricingRates["fixedFareAirport"],
): number {
  return tierFare(category === "malpensa" ? fixedFareAirport.malpensa : fixedFareAirport.linateOrioCitta, passengers);
}

// Tier "4" covers 1-4 passengers; then one tier per passenger up to 8.
function tierFare(table: PassengerTierRates, passengers: number): number {
  const tiers = ["4", "5", "6", "7", "8"] as const;
  for (const tier of tiers) {
    if (passengers <= Number(tier)) return table[tier];
  }
  // Unreachable: callers only reach here after confirming passengers <= 8.
  return table["8"];
}

// Hospital detection is cross-cutting — evaluated once, independent of
// which pricing branch the base transfer takes. Fixes the gap found in
// CChiefGrowthAI's own code, where the equivalent check only ever fired
// inside the fixed-fare branch, never on a km-calculated destination
// (e.g. "Ospedale di Sondalo", CChiefGrowthAI's own test example).
// `rates` is nullable here specifically: calculatePrice() calls this
// before its own top-level "rates could not be resolved safely" check (see
// that function's own comment), so this needs its own honest answer for
// that case too — never guessing a value it doesn't have. When `rates` is
// null, an italian hospital destination gets the same manual_required
// treatment foreign already gets below: applies=true (that fact doesn't
// depend on rates), but no rate is invented.
function evaluateHospitalWaiting(
  destination: string,
  customerType: CustomerType,
  rates: PricingRates | null,
): HospitalWaitingInfo {
  const applies = HOSPITAL_KEYWORDS.some((keyword) => destination.toLowerCase().includes(keyword));

  if (!applies) {
    return { applies: false, hospitalWaitingStatus: "not_applicable", hospitalWaitingRule: null, freeMinutes: null, ratePerHourCents: null };
  }

  if (customerType === "italian" && rates) {
    return {
      applies: true,
      hospitalWaitingStatus: "defined",
      hospitalWaitingRule: "1h_free_then_40_eur_per_hour",
      freeMinutes: rates.hospitalWaitingItalian.freeMinutes,
      ratePerHourCents: rates.hospitalWaitingItalian.ratePerHourCents,
    };
  }

  // Foreign (rule not yet defined), or rates unavailable: never guessed,
  // never defaulted to the italian rate.
  return { applies: true, hospitalWaitingStatus: "manual_required", hospitalWaitingRule: null, freeMinutes: null, ratePerHourCents: null };
}

function buildManualRequired(
  customerType: CustomerType,
  reason: ManualRequiredReason,
  hospitalWaiting: HospitalWaitingInfo,
  minimumFareCents: number,
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
      minimumFareCents,
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
  minimumFareCents: number,
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
      minimumFareCents,
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
  rates: PricingRates,
): PricingResult {
  const rate = kmRate(customerType, distanceKm, rates.distanceRate);
  const baseAmountCents = Math.round(distanceKm * rate * 100);
  const tollAmountCents = Math.round(distanceKm * rates.tollRatePerKm * 100);
  const computedTotalCents = baseAmountCents + tollAmountCents;
  const minimumFareApplied = computedTotalCents < rates.minimumFareCents;
  const finalAmountCents = Math.max(computedTotalCents, rates.minimumFareCents);

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
      minimumFareCents: rates.minimumFareCents,
      minimumFareApplied,
      manualRequiredReason: null,
      warnings: [],
    },
  };
}

// The single entry point. Pure — no DB, no network, no side effects — even
// after Phase 2 (Business Rules): `rates` is a plain value the caller
// resolved beforehand (see rates-provider.ts), never fetched here.
// Defaults to DEFAULT_PRICING_RATES so every pre-Phase-2 caller/test that
// never passed a second argument at all keeps computing the exact same
// numbers as before — this default is the whole reason OLD and NEW prices
// are provably identical, not just "equivalent": they run the identical
// arithmetic against the identical values, because DEFAULT_PRICING_RATES
// *is* the same values, just moved from a scattered set of module
// constants into one named export.
//
// `rates === null` is the one new case: the caller determined the tariff
// values could not be safely resolved from the Business Rules system this
// run (an effective rule's content failed validation, or more than one
// effective version existed for the same rule) and explicitly chose not to
// guess. Checked first, before any routing logic, so no branch below ever
// computes a price using a rate it can't trust.
//
// Never throws on business-shape issues (missing passengers, missing
// distance, or now unavailable rates): every such case resolves to a
// manual_required PricingResult instead, per the "conservative engine,
// never guess" mandate.
export function calculatePrice(input: PricingInput, rates: PricingRates | null = DEFAULT_PRICING_RATES): PricingResult {
  const hospitalWaiting = evaluateHospitalWaiting(input.destination, input.customerType, rates);

  if (rates === null) {
    return buildManualRequired(input.customerType, "pricing_rules_invalid", hospitalWaiting, DEFAULT_PRICING_RATES.minimumFareCents);
  }

  // Intake signals that immediately defer — see schema.ts's comment on why
  // these fields exist. None of them compute a price; they only let the
  // engine recognize a case it must not guess at.
  if (input.requestedServiceType === "hourly") {
    return buildManualRequired(input.customerType, "hourly_formula_not_defined", hospitalWaiting, rates.minimumFareCents);
  }
  if (input.channel === "gettransfer") {
    return buildManualRequired(input.customerType, "gettransfer_base_tariff_not_defined", hospitalWaiting, rates.minimumFareCents);
  }
  if (input.channel === "viator") {
    return buildManualRequired(input.customerType, "viator_external_price_not_provided", hospitalWaiting, rates.minimumFareCents);
  }
  if (input.possibleNightOrHolidaySurcharge && input.customerType === "foreign") {
    return buildManualRequired(
      input.customerType,
      "night_holiday_surcharge_requires_admin_decision",
      hospitalWaiting,
      rates.minimumFareCents,
    );
  }

  if (!Number.isInteger(input.passengers) || input.passengers <= 0) {
    return buildManualRequired(input.customerType, "passengers_missing", hospitalWaiting, rates.minimumFareCents);
  }

  // Foreign Lake Como <-> Tirano commercial fixed fares — checked first,
  // ahead of every other branch, for exactly the reasons in the comment
  // above FOREIGN_FIXED_TIRANO_MATCHED_RULE.
  if (input.customerType === "foreign") {
    const namedRoute = matchForeignFixedTiranoRoute(input.pickup, input.destination);
    if (namedRoute) {
      if (input.passengers > 4) {
        return buildManualRequired(input.customerType, "passengers_above_supported_fare_band", hospitalWaiting, rates.minimumFareCents);
      }
      return buildFixedResult(
        input.customerType,
        rates.foreignFixedTirano[namedRoute],
        FOREIGN_FIXED_TIRANO_MATCHED_RULE[namedRoute],
        hospitalWaiting,
        rates.minimumFareCents,
      );
    }

    if (isOtherLakeComoMention(input.pickup, input.destination)) {
      return buildManualRequired(
        input.customerType,
        "lake_como_location_requires_personalized_quote",
        hospitalWaiting,
        rates.minimumFareCents,
      );
    }
  }

  if (isComoTiranoRoute(input.pickup, input.destination)) {
    // customerType is always "italian" by the time execution reaches here —
    // a foreign customer on this same route was already resolved above by
    // the named fixed-fare branch (matchForeignFixedTiranoRoute's "como"
    // keyword matches whenever isComoTiranoRoute does, for a foreign
    // customer, so that branch never falls through to this one).
    if (input.distanceKm === undefined) {
      return buildManualRequired(input.customerType, "distance_not_provided", hospitalWaiting, rates.minimumFareCents);
    }
    return buildKmResult(input.customerType, input.distanceKm, "como_tirano_km_italian", hospitalWaiting, rates);
  }

  // Sondrio city <-> Malpensa, both directions (founder decision,
  // 2026-09-25, Business Rule pricing.fixed_fare.sondrio_malpensa): italian
  // customers by passenger tier, foreign customers one flat fare for 1-8,
  // never per km. Checked before the airport table below. Other Valtellina
  // towns are not covered. No effective rule (null) = previous behavior.
  const sondrioMalpensa = rates.sondrioMalpensa;
  if (
    sondrioMalpensa &&
    ((isSondrioCity(input.pickup) && isMalpensa(input.destination)) ||
      (isMalpensa(input.pickup) && isSondrioCity(input.destination)))
  ) {
    if (input.passengers > 8) {
      return buildManualRequired(input.customerType, "passengers_above_supported_fare_band", hospitalWaiting, rates.minimumFareCents);
    }
    if (input.customerType === "italian") {
      return buildFixedResult(
        input.customerType,
        tierFare(sondrioMalpensa.italian, input.passengers),
        "fixed_sondrio_malpensa_italian",
        hospitalWaiting,
        rates.minimumFareCents,
      );
    }
    return buildFixedResult(
      input.customerType,
      sondrioMalpensa.foreignUpTo8PassengersCents,
      "fixed_sondrio_malpensa_foreign",
      hospitalWaiting,
      rates.minimumFareCents,
    );
  }

  // Airport/city table. Destination first, as it always was. Since
  // 2026-09-25 (founder decision) Linate, Orio al Serio/Bergamo and Milano
  // also apply in the reverse direction — the airport or city as pickup and
  // Sondrio as destination — at the same price, for italian and foreign
  // customers alike. Malpensa's reverse direction is the Sondrio-Malpensa
  // rule above, not this table.
  const destinationCategory = findFixedFareCategory(input.destination);
  const pickupCategory = findFixedFareCategory(input.pickup);
  const reverseCategory =
    !destinationCategory && pickupCategory === "linate_orio_citta" && isOriginCompatibleWithFixedFare(input.destination)
      ? pickupCategory
      : null;
  const fixedCategory = destinationCategory ?? reverseCategory;
  if (fixedCategory) {
    if (input.passengers > 8) {
      return buildManualRequired(input.customerType, "passengers_above_supported_fare_band", hospitalWaiting, rates.minimumFareCents);
    }
    if (destinationCategory && !isOriginCompatibleWithFixedFare(input.pickup)) {
      return buildManualRequired(input.customerType, "fixed_fare_origin_requires_verification", hospitalWaiting, rates.minimumFareCents, {
        warnings: ["Pickup location is not Sondrio or a known fixed-fare location — fixed fare cannot be applied automatically."],
      });
    }
    const fareCents = fixedFareForPassengers(fixedCategory, input.passengers, rates.fixedFareAirport);
    const matchedRule: MatchedRule = fixedCategory === "malpensa" ? "fixed_airport_malpensa" : "fixed_airport_linate_orio_city";
    return buildFixedResult(input.customerType, fareCents, matchedRule, hospitalWaiting, rates.minimumFareCents);
  }

  if (input.distanceKm === undefined) {
    return buildManualRequired(input.customerType, "distance_not_provided", hospitalWaiting, rates.minimumFareCents);
  }
  return buildKmResult(input.customerType, input.distanceKm, "generic_km", hospitalWaiting, rates);
}
