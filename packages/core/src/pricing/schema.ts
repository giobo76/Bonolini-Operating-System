import { z } from "zod";

// Named distinctly from clients/schema.ts's customerTypeSchema (private vs
// company billing type) — this is a different concept: nationality-based
// pricing classification (cliente_e_straniero from CChiefGrowthAI).
export const pricingCustomerTypeSchema = z.enum(["italian", "foreign"]);
export type CustomerType = z.infer<typeof pricingCustomerTypeSchema>;

export const pricingStatusSchema = z.enum(["fixed", "calculated_km", "manual_required"]);
export type PricingStatus = z.infer<typeof pricingStatusSchema>;

// requestedServiceType / channel / possibleNightOrHolidaySurcharge are
// deliberately minimal intake signals, not calculation logic: they let a
// caller say "this is hourly" / "this came via GetTransfer or Viator" /
// "this might need the night/holiday surcharge review" so the engine can
// defer to manual_required immediately, without inventing a formula for
// any of them. See README.md's "Founder decisions" section.
export const pricingInputSchema = z.object({
  customerType: pricingCustomerTypeSchema,
  pickup: z.string().trim().min(1),
  destination: z.string().trim().min(1),
  passengers: z.number().int().positive(),
  // Total km already computed by the caller, per the route's own
  // convention (round-trip for generic point-to-point, sum of 3 legs for
  // Como-Tirano italian) — this module never calls Google Maps or any
  // distance API itself.
  distanceKm: z.number().positive().optional(),
  requestedServiceType: z.enum(["point_to_point", "hourly"]).default("point_to_point"),
  channel: z.enum(["direct", "gettransfer", "viator"]).default("direct"),
  possibleNightOrHolidaySurcharge: z.boolean().default(false),
});
export type PricingInput = z.infer<typeof pricingInputSchema>;

export type ManualRequiredReason =
  | "passengers_missing"
  | "passengers_above_supported_fare_band"
  | "fixed_fare_origin_requires_verification"
  | "distance_not_provided"
  | "hourly_formula_not_defined"
  | "gettransfer_base_tariff_not_defined"
  | "viator_external_price_not_provided"
  | "night_holiday_surcharge_requires_admin_decision"
  // Added for the named foreign Lake Como <-> Tirano fixed fares (see
  // service.ts's FOREIGN_FIXED_TIRANO_*): a recognized Lake Como location
  // (Bellagio, Tremezzo, etc.) other than the three with a published fare
  // (Varenna, Menaggio, Como) — a deliberate commercial decision not to
  // auto-price it, not a missing-data gap like distance_not_provided.
  | "lake_como_location_requires_personalized_quote"
  // Phase 2 (Business Rules): the caller passed `rates: null` — the tariff
  // values could not be safely resolved from the Business Rules system
  // (a rule's effective content failed validation, or more than one
  // effective version existed for the same rule — both real configuration
  // errors, never silently papered over by guessing a price). Distinct
  // from every reason above, which is about the *input*/route never
  // having a formula at all — this one is about the engine's own tariff
  // configuration being untrustworthy this run. See rates-provider.ts.
  | "pricing_rules_invalid"
  | null;

export type MatchedRule =
  | "fixed_airport_linate_orio_city"
  | "fixed_airport_malpensa"
  | "como_tirano_fixed_foreign"
  | "como_tirano_km_italian"
  // The four other named foreign fixed routes to/from Tirano, added
  // alongside como_tirano_fixed_foreign above — same commercial mechanism,
  // one MatchedRule per route (matching the existing fixed_airport_*
  // convention of one rule per fare table, not a single generic value).
  | "varenna_tirano_fixed_foreign"
  | "menaggio_tirano_fixed_foreign"
  | "milan_tirano_fixed_foreign"
  | "malpensa_tirano_fixed_foreign"
  | "generic_km"
  | "manual_required";

export interface PricingAdjustment {
  type: string;
  amountCents: number;
  reason: string;
}

export interface PricingBreakdown {
  matchedRule: MatchedRule;
  distanceKmUsed: number | null;
  ratePerKmApplied: number | null;
  fixedFareApplied: number | null;
  tollEstimateCents: number | null;
  // Phase 2: was the literal type `5000` — widened to `number` now that
  // this value comes from the Business Rules system (`pricing.minimum_fare`)
  // rather than a single hardcoded constant. DEFAULT_PRICING_RATES below
  // still equals exactly 5000, so every existing caller/test that expected
  // that literal value is unaffected in practice.
  minimumFareCents: number;
  minimumFareApplied: boolean;
  manualRequiredReason: ManualRequiredReason;
  warnings: string[];
}

// Deliberately separate from pricingStatus/finalAmountCents — the hospital
// waiting fee is never summed into the transfer price automatically
// (actual wait duration is unknown at pricing time). See README.md.
export interface HospitalWaitingInfo {
  applies: boolean;
  hospitalWaitingStatus: "not_applicable" | "defined" | "manual_required";
  hospitalWaitingRule: "1h_free_then_40_eur_per_hour" | null;
  // Phase 2: widened from the literal types `60`/`4000` to `number` for the
  // same reason as minimumFareCents above — DEFAULT_PRICING_RATES still
  // equals exactly 60/4000.
  freeMinutes: number | null;
  ratePerHourCents: number | null;
}

// ── Business Rules content shapes (Phase 2) ───────────────────────────────
// Every tariff *value* previously hardcoded as a module-level constant in
// service.ts, now the shape of a `business_rule_versions.content` for a
// `category: "pricing"` rule. Deliberately excludes anything that is
// route/destination *classification* rather than a commercial value
// (AIRPORT_FARE_CATEGORY's keyword table, HOSPITAL_KEYWORDS,
// FOREIGN_FIXED_TIRANO_KEYWORDS, OTHER_LAKE_COMO_KEYWORDS,
// isOriginCompatibleWithFixedFare) — those stay hardcoded logic in
// service.ts, unchanged; only the numbers a founder might actually want to
// change without a code deploy became Business Rules. GetTransfer/Viator
// are deliberately NOT represented here: today's code returns
// manual_required for both, unconditionally, with no formula and no
// constant of any kind — there is nothing to migrate for them (see
// rates-provider.ts's own header comment).

export const pricingRuleKeys = {
  minimumFare: "pricing.minimum_fare",
  tollRate: "pricing.toll_rate",
  distanceRate: "pricing.distance_rate",
  fixedFareAirport: "pricing.fixed_fare.airport",
  foreignFixedTirano: "pricing.fixed_fare.foreign_tirano",
  hospitalWaitingItalian: "pricing.hospital_waiting.italian",
} as const;

const passengerTierContentSchema = z.object({
  "4": z.number().int().positive(),
  "5": z.number().int().positive(),
  "6": z.number().int().positive(),
  "7": z.number().int().positive(),
  "8": z.number().int().positive(),
});

export const minimumFareRuleContentSchema = z.object({ minimumFareCents: z.number().int().positive() });
export const tollRateRuleContentSchema = z.object({ ratePerKm: z.number().positive() });
export const distanceRateRuleContentSchema = z.object({
  italianUpTo100Km: z.number().positive(),
  italianAbove100Km: z.number().positive(),
  foreignUpTo100Km: z.number().positive(),
  foreignAbove100Km: z.number().positive(),
});
export const fixedFareAirportRuleContentSchema = z.object({
  linateOrioCitta: passengerTierContentSchema,
  malpensa: passengerTierContentSchema,
});
export const foreignFixedTiranoRuleContentSchema = z.object({
  varenna: z.number().int().positive(),
  menaggio: z.number().int().positive(),
  como: z.number().int().positive(),
  milan: z.number().int().positive(),
  malpensa: z.number().int().positive(),
});
export const hospitalWaitingItalianRuleContentSchema = z.object({
  freeMinutes: z.number().int().nonnegative(),
  ratePerHourCents: z.number().int().nonnegative(),
});

export type PassengerTierRates = z.infer<typeof passengerTierContentSchema>;
export type MinimumFareRuleContent = z.infer<typeof minimumFareRuleContentSchema>;
export type TollRateRuleContent = z.infer<typeof tollRateRuleContentSchema>;
export type DistanceRateRuleContent = z.infer<typeof distanceRateRuleContentSchema>;
export type FixedFareAirportRuleContent = z.infer<typeof fixedFareAirportRuleContentSchema>;
export type ForeignFixedTiranoRuleContent = z.infer<typeof foreignFixedTiranoRuleContentSchema>;
export type HospitalWaitingItalianRuleContent = z.infer<typeof hospitalWaitingItalianRuleContentSchema>;

// The one shape calculatePrice() actually consumes — assembled by
// rates-provider.ts from the six Business Rules above (or, until they
// exist/are approved, from DEFAULT_PRICING_RATES below). calculatePrice()
// itself has no idea whether a given PricingRates came from the database
// or from this default — it stays a pure function either way.
export interface PricingRates {
  minimumFareCents: number;
  tollRatePerKm: number;
  distanceRate: DistanceRateRuleContent;
  fixedFareAirport: FixedFareAirportRuleContent;
  foreignFixedTirano: ForeignFixedTiranoRuleContent;
  hospitalWaitingItalian: HospitalWaitingItalianRuleContent;
}

// Recovered verbatim from the same CChiefGrowthAI-derived constants
// service.ts hardcoded before Phase 2 — kept here, unchanged, as: (a) the
// initial content every migration-seeded Business Rule is set to, so the
// system is immediately equivalent to the pre-Phase-2 behavior the moment
// the migration runs; (b) calculatePrice()'s own default second argument,
// so every pre-Phase-2 caller/test that never passed a `rates` argument at
// all keeps computing the exact same numbers; (c) the explicit, documented,
// temporary fallback rates-provider.ts uses when a rule is missing or has
// no effective version yet (e.g. before this phase's migration has been
// applied) — never used to paper over a rule that exists but is invalid,
// see rates-provider.ts.
export const DEFAULT_PRICING_RATES: PricingRates = {
  minimumFareCents: 5000,
  tollRatePerKm: 0.08,
  distanceRate: { italianUpTo100Km: 1.0, italianAbove100Km: 0.85, foreignUpTo100Km: 1.3, foreignAbove100Km: 1.2 },
  fixedFareAirport: {
    linateOrioCitta: { "4": 22000, "5": 25000, "6": 28000, "7": 30000, "8": 32000 },
    malpensa: { "4": 25000, "5": 27000, "6": 29000, "7": 32000, "8": 35000 },
  },
  foreignFixedTirano: { varenna: 26000, menaggio: 30000, como: 36000, milan: 39000, malpensa: 44000 },
  hospitalWaitingItalian: { freeMinutes: 60, ratePerHourCents: 4000 },
};

export interface PricingResult {
  pricingStatus: PricingStatus;
  customerType: CustomerType;
  serviceType: "point_to_point";
  baseAmountCents: number | null;
  tollAmountCents: number | null;
  adjustments: PricingAdjustment[];
  finalAmountCents: number | null;
  currency: "EUR";
  manualRequiredReason: ManualRequiredReason;
  hospitalWaiting: HospitalWaitingInfo;
  pricingBreakdown: PricingBreakdown;
}
