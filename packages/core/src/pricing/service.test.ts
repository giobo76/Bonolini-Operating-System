import { describe, expect, it } from "vitest";
import { calculatePrice, determineCustomerType } from "./service";
import { DEFAULT_PRICING_RATES } from "./schema";
import type { PricingInput, PricingRates } from "./schema";

// Pure module, no @bos/db mock needed — calculatePrice() never touches the
// database, unlike every other core module's tests.

function input(overrides: Partial<PricingInput> = {}): PricingInput {
  return {
    customerType: "italian",
    pickup: "Sondrio",
    destination: "Livigno",
    passengers: 2,
    requestedServiceType: "point_to_point",
    channel: "direct",
    possibleNightOrHolidaySurcharge: false,
    ...overrides,
  };
}

describe("determineCustomerType", () => {
  it("classifies +39 as italian", () => {
    expect(determineCustomerType("+393281234567")).toBe("italian");
    expect(determineCustomerType("393281234567")).toBe("italian");
  });

  it("classifies any other prefix as foreign", () => {
    expect(determineCustomerType("+447911123456")).toBe("foreign");
    expect(determineCustomerType("+491701234567")).toBe("foreign");
  });
});

describe("calculatePrice — generic km", () => {
  // 1. italiano <= 100km
  it("1: italian, <=100km total, uses the 1.00 EUR/km rate", () => {
    const result = calculatePrice(input({ distanceKm: 60 }));
    expect(result.pricingStatus).toBe("calculated_km");
    expect(result.pricingBreakdown.ratePerKmApplied).toBe(1.0);
    expect(result.baseAmountCents).toBe(6000);
    expect(result.tollAmountCents).toBe(480);
    expect(result.finalAmountCents).toBe(6480);
    expect(result.pricingBreakdown.minimumFareApplied).toBe(false);
  });

  // 2. italiano > 100km
  it("2: italian, >100km total, uses the 0.85 EUR/km rate", () => {
    const result = calculatePrice(input({ distanceKm: 150 }));
    expect(result.pricingBreakdown.ratePerKmApplied).toBe(0.85);
    expect(result.baseAmountCents).toBe(12750);
    expect(result.tollAmountCents).toBe(1200);
    expect(result.finalAmountCents).toBe(13950);
  });

  // 3. straniero <= 100km
  it("3: foreign, <=100km total, uses the 1.30 EUR/km rate", () => {
    const result = calculatePrice(input({ customerType: "foreign", distanceKm: 60 }));
    expect(result.pricingBreakdown.ratePerKmApplied).toBe(1.3);
    expect(result.baseAmountCents).toBe(7800);
    expect(result.finalAmountCents).toBe(8280);
  });

  // 4. straniero > 100km
  it("4: foreign, >100km total, uses the 1.20 EUR/km rate", () => {
    const result = calculatePrice(input({ customerType: "foreign", distanceKm: 150 }));
    expect(result.pricingBreakdown.ratePerKmApplied).toBe(1.2);
    expect(result.baseAmountCents).toBe(18000);
    expect(result.finalAmountCents).toBe(19200);
  });

  // 5. minimum fare
  it("5: a short trip is clamped to the 50 EUR minimum", () => {
    const result = calculatePrice(input({ distanceKm: 10 }));
    expect(result.baseAmountCents! + result.tollAmountCents!).toBeLessThan(5000);
    expect(result.pricingBreakdown.minimumFareApplied).toBe(true);
    expect(result.finalAmountCents).toBe(5000);
  });

  // 13. pedaggio represented separately
  it("13: toll is a separate field, distinct from the per-km base", () => {
    const result = calculatePrice(input({ distanceKm: 60 }));
    expect(result.tollAmountCents).toBe(60 * 0.08 * 100);
    expect(result.pricingBreakdown.tollEstimateCents).toBe(result.tollAmountCents);
  });

  // 14. distance mancante
  it("14: a generic route with no distanceKm defers to manual_required", () => {
    const result = calculatePrice(input({ distanceKm: undefined }));
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.manualRequiredReason).toBe("distance_not_provided");
    expect(result.finalAmountCents).toBeNull();
  });
});

describe("calculatePrice — airport fixed fares", () => {
  // 6. fascia minima (Linate/Orio/città)
  it("6: Linate, 2 passengers, uses the 4-passenger tier", () => {
    const result = calculatePrice(input({ destination: "Linate", passengers: 2 }));
    expect(result.pricingStatus).toBe("fixed");
    expect(result.pricingBreakdown.matchedRule).toBe("fixed_airport_linate_orio_city");
    expect(result.finalAmountCents).toBe(22000);
  });

  it("6b: 1 passenger also uses the 4-passenger tier (no smaller tier exists)", () => {
    const result = calculatePrice(input({ destination: "Linate", passengers: 1 }));
    expect(result.finalAmountCents).toBe(22000);
  });

  // 7. fascia massima
  it("7: Linate, 8 passengers, uses the 8-passenger tier", () => {
    const result = calculatePrice(input({ destination: "Linate", passengers: 8 }));
    expect(result.finalAmountCents).toBe(32000);
  });

  // 8. Malpensa
  it("8: Malpensa, 5 passengers", () => {
    const result = calculatePrice(input({ destination: "Malpensa", passengers: 5 }));
    expect(result.pricingBreakdown.matchedRule).toBe("fixed_airport_malpensa");
    expect(result.finalAmountCents).toBe(27000);
  });

  // 9. oltre 8 pax
  it("9: more than 8 passengers on a fixed fare defers to manual_required, no fallback price", () => {
    const result = calculatePrice(input({ destination: "Malpensa", passengers: 9 }));
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.manualRequiredReason).toBe("passengers_above_supported_fare_band");
    expect(result.finalAmountCents).toBeNull();
  });

  // 10. origine incompatibile
  it("10: pickup incompatible with the fixed-fare table defers to manual_required", () => {
    const result = calculatePrice(input({ pickup: "Roma", destination: "Malpensa", passengers: 2 }));
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.manualRequiredReason).toBe("fixed_fare_origin_requires_verification");
    expect(result.pricingBreakdown.warnings.length).toBeGreaterThan(0);
  });

  it("10b: pickup at an airport itself (a return leg) is compatible with the fixed fare", () => {
    const result = calculatePrice(input({ pickup: "Malpensa", destination: "Linate", passengers: 2 }));
    expect(result.pricingStatus).toBe("fixed");
  });
});

describe("calculatePrice — Como-Tirano", () => {
  // 11. straniero
  it("11: foreign Como-Tirano is a fixed 360 EUR, no distance needed", () => {
    const result = calculatePrice(input({ customerType: "foreign", pickup: "Como", destination: "Tirano" }));
    expect(result.pricingStatus).toBe("fixed");
    expect(result.pricingBreakdown.matchedRule).toBe("como_tirano_fixed_foreign");
    expect(result.finalAmountCents).toBe(36000);
  });

  // 12. italiano
  it("12: italian Como-Tirano uses the km formula on the supplied 3-leg total", () => {
    const result = calculatePrice(input({ pickup: "Como", destination: "Tirano", distanceKm: 85 }));
    expect(result.pricingStatus).toBe("calculated_km");
    expect(result.pricingBreakdown.matchedRule).toBe("como_tirano_km_italian");
    expect(result.baseAmountCents).toBe(8500);
    expect(result.tollAmountCents).toBe(680);
    expect(result.finalAmountCents).toBe(9180);
  });

  it("12b: italian Como-Tirano without a distance defers to manual_required", () => {
    const result = calculatePrice(input({ pickup: "Como", destination: "Tirano", distanceKm: undefined }));
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.manualRequiredReason).toBe("distance_not_provided");
  });
});

describe("calculatePrice — hospital waiting (separate from transfer price)", () => {
  // 15. ospedale italiano
  it("15: italian hospital destination — transfer price computed normally, waiting rule attached separately", () => {
    const result = calculatePrice(input({ destination: "Ospedale di Sondalo", distanceKm: 20 }));
    expect(result.pricingStatus).toBe("calculated_km");
    expect(result.finalAmountCents).not.toBeNull();
    expect(result.hospitalWaiting).toEqual({
      applies: true,
      hospitalWaitingStatus: "defined",
      hospitalWaitingRule: "1h_free_then_40_eur_per_hour",
      freeMinutes: 60,
      ratePerHourCents: 4000,
    });
  });

  // 16. ospedale straniero
  it("16: foreign hospital destination — transfer price still computed, waiting rule is manual_required", () => {
    const result = calculatePrice(input({ customerType: "foreign", destination: "Ospedale di Sondalo", distanceKm: 20 }));
    expect(result.pricingStatus).toBe("calculated_km");
    expect(result.finalAmountCents).not.toBeNull();
    expect(result.hospitalWaiting.hospitalWaitingStatus).toBe("manual_required");
    expect(result.hospitalWaiting.ratePerHourCents).toBeNull();
  });

  it("non-hospital destination has no waiting rule attached", () => {
    const result = calculatePrice(input({ distanceKm: 20 }));
    expect(result.hospitalWaiting.applies).toBe(false);
    expect(result.hospitalWaiting.hospitalWaitingStatus).toBe("not_applicable");
  });
});

describe("calculatePrice — deferred cases (never guessed)", () => {
  // 17. hourly
  it("17: hourly/disposal defers to manual_required — no formula exists", () => {
    const result = calculatePrice(input({ requestedServiceType: "hourly" }));
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.manualRequiredReason).toBe("hourly_formula_not_defined");
  });

  // 18. notturno/festivo
  it("18: a possible night/holiday case for a foreign customer defers to manual_required", () => {
    const result = calculatePrice(input({ customerType: "foreign", distanceKm: 60, possibleNightOrHolidaySurcharge: true }));
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.manualRequiredReason).toBe("night_holiday_surcharge_requires_admin_decision");
  });

  it("18b: the same flag on an italian customer does NOT defer (surcharge is foreign-only)", () => {
    const result = calculatePrice(input({ customerType: "italian", distanceKm: 60, possibleNightOrHolidaySurcharge: true }));
    expect(result.pricingStatus).toBe("calculated_km");
  });

  // 19. GetTransfer
  it("19: GetTransfer channel defers to manual_required — base tariff definition not confirmed", () => {
    const result = calculatePrice(input({ channel: "gettransfer" }));
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.manualRequiredReason).toBe("gettransfer_base_tariff_not_defined");
  });

  // 20. Viator
  it("20: Viator channel defers to manual_required — no technical intake for the external price exists yet", () => {
    const result = calculatePrice(input({ channel: "viator" }));
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.manualRequiredReason).toBe("viator_external_price_not_provided");
  });
});

describe("calculatePrice — defensive edge cases", () => {
  it("missing/invalid passengers defers to manual_required rather than throwing", () => {
    const result = calculatePrice(input({ passengers: 0 }));
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.manualRequiredReason).toBe("passengers_missing");
  });
});

// Founder-approved commercial fixed fares for the English/foreign-facing
// site pages (2026-08-31): Varenna/Menaggio/Como/Milan/Malpensa <-> Tirano,
// up to 4 passengers, identical in both directions. See service.ts's
// FOREIGN_FIXED_TIRANO_* comment for why these are checked ahead of the
// pre-existing airport-fixed-fare and Como-Tirano branches.
describe("calculatePrice — foreign Lake Como / Milan / Malpensa <-> Tirano fixed fares", () => {
  const NAMED_ROUTES: Array<{ town: string; label: string; fareCents: number; matchedRule: string }> = [
    { town: "Varenna", label: "varenna_tirano_fixed_foreign", fareCents: 26000, matchedRule: "varenna_tirano_fixed_foreign" },
    { town: "Menaggio", label: "menaggio_tirano_fixed_foreign", fareCents: 30000, matchedRule: "menaggio_tirano_fixed_foreign" },
    { town: "Como", label: "como_tirano_fixed_foreign", fareCents: 36000, matchedRule: "como_tirano_fixed_foreign" },
    { town: "Milan", label: "milan_tirano_fixed_foreign", fareCents: 39000, matchedRule: "milan_tirano_fixed_foreign" },
    { town: "Malpensa", label: "malpensa_tirano_fixed_foreign", fareCents: 44000, matchedRule: "malpensa_tirano_fixed_foreign" },
  ];

  describe.each(NAMED_ROUTES)("$town <-> Tirano", ({ town, fareCents, matchedRule }) => {
    // FOREIGN — 1 pax, both directions
    it(`1 pax: ${town} -> Tirano and Tirano -> ${town} both resolve to the same fixed fare`, () => {
      const forward = calculatePrice(input({ customerType: "foreign", pickup: town, destination: "Tirano", passengers: 1 }));
      const backward = calculatePrice(input({ customerType: "foreign", pickup: "Tirano", destination: town, passengers: 1 }));

      for (const result of [forward, backward]) {
        expect(result.pricingStatus).toBe("fixed");
        expect(result.pricingBreakdown.matchedRule).toBe(matchedRule);
        expect(result.finalAmountCents).toBe(fareCents);
      }
      expect(forward.finalAmountCents).toBe(backward.finalAmountCents);
    });

    // FOREIGN — 4 pax, both directions (upper edge of the published band)
    it(`4 pax: ${town} -> Tirano and Tirano -> ${town} both resolve to the same fixed fare`, () => {
      const forward = calculatePrice(input({ customerType: "foreign", pickup: town, destination: "Tirano", passengers: 4 }));
      const backward = calculatePrice(input({ customerType: "foreign", pickup: "Tirano", destination: town, passengers: 4 }));

      for (const result of [forward, backward]) {
        expect(result.pricingStatus).toBe("fixed");
        expect(result.finalAmountCents).toBe(fareCents);
      }
    });

    // FOREIGN — 5 pax: personalized quote, never a base price
    it(`5 pax: ${town} <-> Tirano defers to manual_required, never a fixed price`, () => {
      const forward = calculatePrice(input({ customerType: "foreign", pickup: town, destination: "Tirano", passengers: 5 }));
      const backward = calculatePrice(input({ customerType: "foreign", pickup: "Tirano", destination: town, passengers: 5 }));

      for (const result of [forward, backward]) {
        expect(result.pricingStatus).toBe("manual_required");
        expect(result.manualRequiredReason).toBe("passengers_above_supported_fare_band");
        expect(result.finalAmountCents).toBeNull();
      }
    });

    // FOREIGN — 8 pax: same
    it(`8 pax: ${town} <-> Tirano defers to manual_required, never a fixed price`, () => {
      const forward = calculatePrice(input({ customerType: "foreign", pickup: town, destination: "Tirano", passengers: 8 }));
      const backward = calculatePrice(input({ customerType: "foreign", pickup: "Tirano", destination: town, passengers: 8 }));

      for (const result of [forward, backward]) {
        expect(result.pricingStatus).toBe("manual_required");
        expect(result.manualRequiredReason).toBe("passengers_above_supported_fare_band");
        expect(result.finalAmountCents).toBeNull();
      }
    });
  });

  // FOREIGN — other Lake Como locations: no fixed price, ever, regardless
  // of passenger count.
  describe.each(["Bellagio", "Tremezzo"])("%s <-> Tirano (no published fare)", (town) => {
    it("never returns a fixed price in either direction, 1-4 pax", () => {
      const forward = calculatePrice(input({ customerType: "foreign", pickup: town, destination: "Tirano", passengers: 2 }));
      const backward = calculatePrice(input({ customerType: "foreign", pickup: "Tirano", destination: town, passengers: 2 }));

      for (const result of [forward, backward]) {
        expect(result.pricingStatus).toBe("manual_required");
        expect(result.manualRequiredReason).toBe("lake_como_location_requires_personalized_quote");
        expect(result.finalAmountCents).toBeNull();
      }
    });

    it("does not fall through to a generic_km price even when a distance is supplied", () => {
      const result = calculatePrice(
        input({ customerType: "foreign", pickup: town, destination: "Tirano", passengers: 2, distanceKm: 150 }),
      );
      expect(result.pricingStatus).toBe("manual_required");
      expect(result.pricingBreakdown.matchedRule).toBe("manual_required");
    });
  });

  // ITALIAN regression: none of the five new named routes should affect an
  // italian customer at all — they must keep using exactly the pre-existing
  // rules (Como-Tirano km-based, Milan/Malpensa generic_km unless already
  // covered by the airport table).
  describe("italian customers are unaffected by the new foreign fixed fares", () => {
    it("Varenna/Menaggio <-> Tirano still fall through to generic_km for an italian customer", () => {
      for (const town of ["Varenna", "Menaggio"]) {
        const result = calculatePrice(input({ customerType: "italian", pickup: town, destination: "Tirano", distanceKm: 115.5 }));
        expect(result.pricingStatus).toBe("calculated_km");
        expect(result.pricingBreakdown.matchedRule).toBe("generic_km");
      }
    });

    it("Como <-> Tirano still uses como_tirano_km_italian for an italian customer, unchanged", () => {
      const result = calculatePrice(input({ customerType: "italian", pickup: "Como", destination: "Tirano", distanceKm: 85 }));
      expect(result.pricingStatus).toBe("calculated_km");
      expect(result.pricingBreakdown.matchedRule).toBe("como_tirano_km_italian");
      expect(result.finalAmountCents).toBe(9180); // unchanged from test 12 above
    });

    it("Milan -> Tirano still falls through to generic_km for an italian customer (no fixed fare exists for this direction/customer type)", () => {
      const result = calculatePrice(input({ customerType: "italian", pickup: "Milan", destination: "Tirano", distanceKm: 145 }));
      expect(result.pricingStatus).toBe("calculated_km");
      expect(result.pricingBreakdown.matchedRule).toBe("generic_km");
    });

    it("Malpensa -> Tirano still falls through to generic_km for an italian customer", () => {
      const result = calculatePrice(input({ customerType: "italian", pickup: "Malpensa", destination: "Tirano", distanceKm: 175 }));
      expect(result.pricingStatus).toBe("calculated_km");
      expect(result.pricingBreakdown.matchedRule).toBe("generic_km");
    });

    it("Bellagio/Tremezzo <-> Tirano still fall through to generic_km for an italian customer (the new manual_required rule is foreign-only)", () => {
      for (const town of ["Bellagio", "Tremezzo"]) {
        const result = calculatePrice(input({ customerType: "italian", pickup: town, destination: "Tirano", distanceKm: 156.5 }));
        expect(result.pricingStatus).toBe("calculated_km");
        expect(result.pricingBreakdown.matchedRule).toBe("generic_km");
      }
    });

    it("italian airport fixed fares (Malpensa/Linate as destination) are completely unaffected", () => {
      const malpensa = calculatePrice(input({ customerType: "italian", destination: "Malpensa", passengers: 5 }));
      expect(malpensa.pricingBreakdown.matchedRule).toBe("fixed_airport_malpensa");
      expect(malpensa.finalAmountCents).toBe(27000);

      const linate = calculatePrice(input({ customerType: "italian", destination: "Linate", passengers: 8 }));
      expect(linate.pricingBreakdown.matchedRule).toBe("fixed_airport_linate_orio_city");
      expect(linate.finalAmountCents).toBe(32000);
    });
  });

  // Regression: an unrelated foreign route (no "Tirano" anywhere) must be
  // completely untouched by all of the new logic above.
  it("a foreign route with no Tirano anywhere is unaffected (existing airport-fare/generic-km behavior preserved)", () => {
    const airport = calculatePrice(input({ customerType: "foreign", pickup: "Sondrio", destination: "Malpensa", passengers: 2 }));
    expect(airport.pricingBreakdown.matchedRule).toBe("fixed_airport_malpensa");

    // Livigno matches no airport keyword and no Tirano/Como mention — a
    // genuinely unrelated generic_km route, unlike "Milano" as a
    // destination (which would hit the pre-existing airport-fare table).
    const generic = calculatePrice(input({ customerType: "foreign", pickup: "Bellagio", destination: "Livigno", distanceKm: 80 }));
    expect(generic.pricingBreakdown.matchedRule).toBe("generic_km");
  });
});

// PHASE 2 (Business Rules): calculatePrice() gained an optional second
// `rates` parameter, defaulting to DEFAULT_PRICING_RATES — every test
// above calls calculatePrice(input) with exactly one argument, so every
// one of them already proves OLD price === NEW price for its case: same
// test code, same assertions, unmodified, passing against the refactored
// implementation. These new tests exercise only the new parameter itself.
describe("calculatePrice — rates parameter (Phase 2: Business Rules)", () => {
  it("uses DEFAULT_PRICING_RATES's exact numbers when no rates argument is passed at all", () => {
    const withDefaultArg = calculatePrice(input({ distanceKm: 60 }), DEFAULT_PRICING_RATES);
    const withNoArg = calculatePrice(input({ distanceKm: 60 }));
    expect(withNoArg).toEqual(withDefaultArg);
  });

  it("a custom rates object changes the price deterministically, proving the value is genuinely read from `rates`, not still hardcoded", () => {
    const customRates: PricingRates = {
      ...DEFAULT_PRICING_RATES,
      distanceRate: { ...DEFAULT_PRICING_RATES.distanceRate, italianUpTo100Km: 2.0 },
    };
    const result = calculatePrice(input({ distanceKm: 60 }), customRates);
    expect(result.pricingBreakdown.ratePerKmApplied).toBe(2.0);
    expect(result.baseAmountCents).toBe(12000); // 60km * 2.00 EUR/km, not the default 1.00
  });

  it("a custom minimum fare is honored", () => {
    const customRates: PricingRates = { ...DEFAULT_PRICING_RATES, minimumFareCents: 9000 };
    const result = calculatePrice(input({ distanceKm: 10 }), customRates);
    expect(result.pricingBreakdown.minimumFareApplied).toBe(true);
    expect(result.finalAmountCents).toBe(9000);
  });

  it("a custom fixed airport fare is honored", () => {
    const customRates: PricingRates = {
      ...DEFAULT_PRICING_RATES,
      fixedFareAirport: {
        ...DEFAULT_PRICING_RATES.fixedFareAirport,
        malpensa: { ...DEFAULT_PRICING_RATES.fixedFareAirport.malpensa, "5": 99999 },
      },
    };
    const result = calculatePrice(input({ destination: "Malpensa", passengers: 5 }), customRates);
    expect(result.finalAmountCents).toBe(99999);
  });

  it("a custom foreign fixed Tirano fare is honored", () => {
    const customRates: PricingRates = {
      ...DEFAULT_PRICING_RATES,
      foreignFixedTirano: { ...DEFAULT_PRICING_RATES.foreignFixedTirano, como: 40000 },
    };
    const result = calculatePrice(
      input({ customerType: "foreign", pickup: "Como", destination: "Tirano" }),
      customRates,
    );
    expect(result.finalAmountCents).toBe(40000);
  });

  it("a custom hospital waiting rate for italian customers is honored", () => {
    const customRates: PricingRates = {
      ...DEFAULT_PRICING_RATES,
      hospitalWaitingItalian: { freeMinutes: 30, ratePerHourCents: 5000 },
    };
    const result = calculatePrice(input({ destination: "Ospedale di Sondalo", distanceKm: 20 }), customRates);
    expect(result.hospitalWaiting).toEqual({
      applies: true,
      hospitalWaitingStatus: "defined",
      hospitalWaitingRule: "1h_free_then_40_eur_per_hour",
      freeMinutes: 30,
      ratePerHourCents: 5000,
    });
  });

  it("rates=null defers to manual_required with reason 'pricing_rules_invalid' — never inventing a price", () => {
    const result = calculatePrice(input({ distanceKm: 60 }), null);
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.manualRequiredReason).toBe("pricing_rules_invalid");
    expect(result.finalAmountCents).toBeNull();
  });

  it("rates=null on a fixed-fare route also defers, never falling back to any hardcoded price", () => {
    const result = calculatePrice(input({ destination: "Malpensa", passengers: 4 }), null);
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.manualRequiredReason).toBe("pricing_rules_invalid");
  });

  it("rates=null still reports an honest hospitalWaiting for an italian hospital destination — manual_required, never the default rate", () => {
    const result = calculatePrice(input({ destination: "Ospedale di Sondalo", distanceKm: 20 }), null);
    expect(result.hospitalWaiting.applies).toBe(true);
    expect(result.hospitalWaiting.hospitalWaitingStatus).toBe("manual_required");
    expect(result.hospitalWaiting.ratePerHourCents).toBeNull();
  });
});


// Founder decisions 2026-09-25 (production test, case B): Business Rule
// pricing.fixed_fare.sondrio_malpensa — Sondrio city <-> Malpensa, both
// directions, italian by passenger tier, foreign one flat fare, >8 manual.
describe("calculatePrice — Sondrio <-> Malpensa (Business Rule)", () => {
  const RATES: PricingRates = {
    ...DEFAULT_PRICING_RATES,
    sondrioMalpensa: {
      italian: { "4": 25000, "5": 27000, "6": 29000, "7": 32000, "8": 35000 },
      foreignUpTo8PassengersCents: 38000,
    },
  };

  const ROUTES: Array<[string, string]> = [
    ["Sondrio", "Malpensa"],
    ["Malpensa", "Sondrio"],
    ["Aeroporto di Malpensa", "Sondrio centro"],
    ["Stazione di Sondrio", "MXP"],
  ];

  it.each([
    [1, 25000],
    [2, 25000],
    [3, 25000],
    [4, 25000],
    [5, 27000],
    [6, 29000],
    [7, 32000],
    [8, 35000],
  ])("italian, %i passengers: %i cents, in both directions, no distance needed", (passengers, fare) => {
    for (const [pickup, destination] of ROUTES) {
      const result = calculatePrice(input({ pickup, destination, passengers }), RATES);
      expect(result.pricingStatus).toBe("fixed");
      expect(result.finalAmountCents).toBe(fare);
      expect(result.pricingBreakdown.matchedRule).toBe("fixed_sondrio_malpensa_italian");
    }
  });

  it("foreign, 1-8 passengers: 380 EUR flat in both directions, never per km", () => {
    for (const [pickup, destination] of ROUTES) {
      for (const passengers of [1, 4, 5, 8]) {
        const result = calculatePrice(
          input({ customerType: "foreign", pickup, destination, passengers, distanceKm: 300 }),
          RATES,
        );
        expect(result.pricingStatus).toBe("fixed");
        expect(result.finalAmountCents).toBe(38000);
        expect(result.pricingBreakdown.matchedRule).toBe("fixed_sondrio_malpensa_foreign");
        expect(result.pricingBreakdown.distanceKmUsed).toBeNull();
      }
    }
  });

  it("more than 8 passengers: manual price, italian and foreign", () => {
    for (const customerType of ["italian", "foreign"] as const) {
      const result = calculatePrice(input({ customerType, pickup: "Malpensa", destination: "Sondrio", passengers: 9 }), RATES);
      expect(result.pricingStatus).toBe("manual_required");
      expect(result.manualRequiredReason).toBe("passengers_above_supported_fare_band");
    }
  });

  it("another Valtellina town is not covered: Morbegno -> Malpensa is priced exactly as without the rule", () => {
    const withRule = calculatePrice(input({ pickup: "Morbegno", destination: "Malpensa", passengers: 2 }), RATES);
    const withoutRule = calculatePrice(input({ pickup: "Morbegno", destination: "Malpensa", passengers: 2 }));
    expect(withRule).toEqual(withoutRule);
  });

  it("without an effective rule (null) the route keeps its previous pricing", () => {
    const sondrioToMalpensa = calculatePrice(input({ pickup: "Sondrio", destination: "Malpensa", passengers: 5 }));
    expect(sondrioToMalpensa.pricingBreakdown.matchedRule).toBe("fixed_airport_malpensa");
    const malpensaToSondrio = calculatePrice(input({ pickup: "Malpensa", destination: "Sondrio", passengers: 2 }));
    expect(malpensaToSondrio.manualRequiredReason).toBe("distance_not_provided");
  });
});

// Founder decision 2026-09-25: Linate, Orio al Serio/Bergamo and Milano
// apply in both directions at the same price, italian and foreign.
describe("calculatePrice — airport/city table in the reverse direction", () => {
  it.each(["Linate", "Orio al Serio", "Bergamo", "Milano"])("%s -> Sondrio costs the same as Sondrio -> %s", (place) => {
    for (const customerType of ["italian", "foreign"] as const) {
      for (const passengers of [2, 5, 8]) {
        const outbound = calculatePrice(input({ customerType, pickup: "Sondrio", destination: place, passengers }));
        const inbound = calculatePrice(input({ customerType, pickup: place, destination: "Sondrio", passengers }));
        expect(inbound.pricingStatus).toBe("fixed");
        expect(inbound.finalAmountCents).toBe(outbound.finalAmountCents);
        expect(inbound.pricingBreakdown.matchedRule).toBe("fixed_airport_linate_orio_city");
      }
    }
  });

  it("reverse direction above 8 passengers: manual", () => {
    const result = calculatePrice(input({ pickup: "Linate", destination: "Sondrio", passengers: 9 }));
    expect(result.manualRequiredReason).toBe("passengers_above_supported_fare_band");
  });

  it("reverse direction only towards Sondrio: Linate -> Livigno keeps the per-km path", () => {
    const result = calculatePrice(input({ pickup: "Linate", destination: "Livigno", passengers: 2 }));
    expect(result.manualRequiredReason).toBe("distance_not_provided");
  });

  it("Malpensa is not part of the reverse table (it has its own Sondrio-Malpensa rule)", () => {
    const result = calculatePrice(input({ pickup: "Malpensa", destination: "Sondrio", passengers: 2 }));
    expect(result.pricingBreakdown.matchedRule).not.toBe("fixed_airport_malpensa");
  });
});
