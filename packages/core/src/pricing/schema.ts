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
  minimumFareCents: 5000;
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
  freeMinutes: 60 | null;
  ratePerHourCents: 4000 | null;
}

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
