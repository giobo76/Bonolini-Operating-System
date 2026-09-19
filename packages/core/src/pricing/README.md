# pricing — deterministic, conservative price calculation

**Status:** Core v1 (point-to-point fixed airport fares, Como-Tirano, generic km, customer type, minimum fare, toll estimate, hospital waiting-time rule), plus Phase 2 of the BOS Business Intelligence + Autonomy Model: every one of those tariff *values* now lives in the Business Rules system (`../business-rules`) instead of a hardcoded constant — see "Business Rules (Phase 2)" below. Hourly/disposal, night/holiday surcharge, GetTransfer, and Viator are all still recognized but deliberately return `manual_required` — no formula exists for any of them, and Phase 2 deliberately did not invent one (see that section).

**Owns:** nothing persistent in `service.ts` itself — `calculatePrice()` is still a pure function: same `(input, rates)` always produces the same output, no side effects, no I/O. The one deliberate exception is `rates-provider.ts`, which does read the database (via `../business-rules`) specifically to assemble the `rates` argument `calculatePrice()` consumes — see below.

**Exposes:** `calculatePrice`, `determineCustomerType`, `resolvePricingRates`, and every type in `schema.ts` (including `PricingRates`, `DEFAULT_PRICING_RATES`, and the six pricing rule content schemas/keys).

**Emits / Listens to:** — (pure module, not wired into any event flow).

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this and every other domain module follows.

## Source of truth

Every constant here is recovered verbatim from `CChiefGrowthAI/ai/booking_bot/pricing_engine.py`, confirmed unchanged by the founder — never reinterpreted, never blended with `docs/domain/05-pricing-engine.md` (which remains non-binding for commercial values):

| Rule | Value | CChiefGrowthAI source |
|---|---|---|
| Customer type | `+39` → italian, else foreign | `cliente_e_straniero`, `pricing_engine.py:55-63` |
| €/km italian | 1.00€ ≤100km, 0.85€ oltre | `pricing_engine.py:35-36` |
| €/km foreign | 1.30€ ≤100km, 1.20€ oltre | `pricing_engine.py:39-40` |
| Airport fixed fares | Linate/Orio/Milano città/Bergamo città 220-320€; Malpensa 250-350€ | `pricing_engine.py:15-18` |
| Como-Tirano | 360€ fisso foreign; km 3-leg sum italian | `pricing_engine.py:44-47` |
| Toll estimate | 0.08€/km | `pricing_engine.py:42` |
| Minimum fare | €50 | Founder decision — not in CChiefGrowthAI |
| Hospital (italian) | 1h free, then 40€/h | `pricing_engine.py:32, 196-200` |

## Founder decisions applied in this version

- **>8 passengers on a fixed fare** → `manual_required` (`passengers_above_supported_fare_band`). CChiefGrowthAI's own silent fallback to the 8-pax price is **not** carried over.
- **Pickup incompatible with a fixed fare** (not Sondrio, not a known fixed-fare keyword itself) → `manual_required` (`fixed_fare_origin_requires_verification`), fixed fare **not** applied. CChiefGrowthAI's own weaker behavior (apply the fare anyway, just add a warning note) is **not** carried over.
- **Hospital waiting is a separate field** (`hospitalWaiting`), never summed into `finalAmountCents` — the transfer price and the waiting-time rule are independent. Fixes a real gap found in CChiefGrowthAI's own code: there, the hospital note only ever fired inside the fixed-fare branch, never on a km-calculated destination (e.g. "Ospedale di Sondalo", CChiefGrowthAI's own test example in `pricing_engine.py`'s `__main__` block). Here, hospital detection runs once, independent of which pricing branch computes the base fare.
- **Hospital waiting for foreign customers**: `hospitalWaitingStatus: "manual_required"` — never defaults to the italian 40€/h rate.
- **Distance is never calculated here** — `distanceKm` is an input, supplied by the caller according to the route's own convention (round-trip total for generic point-to-point, sum of the 3 legs Sondrio→Como→Tirano→Sondrio for Como-Tirano italian). This module still never calls Google Maps or any distance API itself; that lives in [`packages/core/src/maps-distance`](../maps-distance/README.md), which `transfer-requests` calls when — and only when — `calculatePrice()` itself reports `manualRequiredReason: "distance_not_provided"`. `isComoTiranoRoute` is exported specifically so that caller can pick the right waypoint convention without duplicating this module's own route-matching keywords.

## Intake signals added in this implementation — not in the original spec, added to make deferral testable

`requestedServiceType`, `channel`, and `possibleNightOrHolidaySurcharge` on `PricingInput` are **not** calculation logic — they're minimal flags so a caller can tell the engine "this is hourly" / "this came via GetTransfer or Viator" / "this might need the night/holiday review", letting the engine defer to `manual_required` immediately and correctly instead of silently falling through the point-to-point logic. No formula, tariff, or threshold was invented for any of them — flagged here explicitly since these three fields did not exist in the approved technical plan and were added specifically to satisfy the founder-required test cases for hourly/GetTransfer/Viator/night-holiday deferral.

## Not implemented (returns `manual_required`, no value guessed)

- Hourly/disposal formula (starting prices €40/h italian, €60/h foreign are known — the rest is not)
- Night/holiday +15% surcharge (conditions not defined — every foreign booking flagged via `possibleNightOrHolidaySurcharge` defers, nothing is auto-applied)
- GetTransfer markup (base tariff definition not confirmed)
- Viator pass-through (no technical mechanism yet exists to receive the external price)
- Hospital waiting rate for foreign customers

## Business Rules (Phase 2)

Every tariff *value* in the table above (not the route/destination *classification* logic that decides which value applies — that stays hardcoded, unchanged, in `service.ts`) is now a `category: "pricing"` Business Rule (see `../business-rules`), read at call time by `rates-provider.ts::resolvePricingRates(tenantId)` and assembled into a plain `PricingRates` object:

| Business Rule key | Replaces |
|---|---|
| `pricing.minimum_fare` | `MINIMUM_FARE_CENTS` |
| `pricing.toll_rate` | `TOLL_RATE_PER_KM` |
| `pricing.distance_rate` | the four `kmRate()` values (italian/foreign × ≤100km/>100km) |
| `pricing.fixed_fare.airport` | `FIXED_FARE_TABLE_CENTS` |
| `pricing.fixed_fare.foreign_tirano` | `FOREIGN_FIXED_TIRANO_FARE_CENTS` |
| `pricing.hospital_waiting.italian` | the italian hospital-waiting free-minutes/rate |

**`calculatePrice(input, rates)` is still pure and synchronous** — `rates` is a plain value the caller resolved beforehand, never fetched inside `calculatePrice()` itself. The second argument defaults to `DEFAULT_PRICING_RATES` (the exact same numbers every constant above used to hold), which is *why* every pre-Phase-2 test/caller that never passed a `rates` argument at all keeps computing the identical price — not "an equivalent one," the identical one, by construction.

**Fallback/safety (never invent a price):**
- A missing rule, or one with no effective version yet (the expected state before migration `0022` has been applied) → `resolveRuleSlot` falls back to that one slot's value in `DEFAULT_PRICING_RATES`, logs it (`log("pricing.rates_provider.fallback", ...)`), and records `source: "fallback_default"` in the returned provenance — explicit, temporary (until the rule/version exists), and never silent.
- A rule that exists, has an effective version, but whose `content` fails its own zod schema — or, more than one effective version existing for the same rule (should never happen given business-rules' own state machine) — is a real configuration error, never masked by the fallback above: `resolvePricingRates` returns `rates: null` and logs via `captureException` (`pricing.rates_provider.invalid_content` / `.inconsistent_rule`). `calculatePrice(input, null)` then returns a normal `manual_required` result with `manualRequiredReason: "pricing_rules_invalid"` — no price is ever computed from data that couldn't be trusted.

**Provenance:** every resolution returns, per rule, which source supplied it (`business_rule` with the real `ruleId`/`versionId`/`versionNumber`, or `fallback_default` with why) — `transfer-requests::runPricingForTransferRequest` stores this as `pricingBreakdown.pricingRuleProvenance`, ready for a future "show which rule you applied and why" workflow without needing to touch the pricing engine again.

**Governance:** the BOS can read these rules, apply them (implicitly, by this module existing), analyze them, and propose a new version (`../business-rules`'s `proposeBusinessRuleVersion`/`proposeNewBusinessRule`) — it can never change the price, modify an effective rule, or approve/activate its own proposal. Every change still goes through the founder via `../business-rules`'s `approve`/`reject`. See that module's own README for the full state machine.

**GetTransfer/Viator are deliberately absent from the Business Rules system** — `calculatePrice()` returns `manual_required` for both channels unconditionally (no formula, no constant, in the pre-Phase-2 code or after it). Nothing was migrated for them because nothing existed to migrate; inventing a rule for a formula that was never there would itself be the "guessed price" this whole system exists to prevent.

## Wiring

Called from `transfer-requests::runPricingForTransferRequest`, which resolves `rates` once per pricing attempt (`resolvePricingRates`) and persists the result onto `transfer_requests.pricingStatus`/`calculatedAmountCents`/`pricingBreakdown` (now including `pricingRuleProvenance`/`pricingRulesUsedFallback`), itself triggered automatically by the live WhatsApp webhook via `processTransferRequestForMessageAndPrice`. See [`transfer-requests/README.md`](../transfer-requests/README.md#pricing-connection).
