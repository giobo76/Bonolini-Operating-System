# pricing — deterministic, conservative price calculation

**Status:** Core v1 only — point-to-point (fixed airport fares, Como-Tirano, generic km), customer type, minimum fare, toll estimate, hospital waiting-time rule. Hourly/disposal, night/holiday surcharge, GetTransfer, and Viator are all recognized but deliberately return `manual_required` — no formula exists yet for any of them. See "Not implemented" below.

**Owns:** nothing persistent — this module has no database access at all. `calculatePrice()` is a pure function: same input always produces the same output, no side effects.

**Exposes:** `calculatePrice`, `determineCustomerType`, and every type in `schema.ts`.

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
- **Distance is never calculated here** — `distanceKm` is an input, supplied by the caller according to the route's own convention (round-trip total for generic point-to-point, sum of the 3 legs Sondrio→Como→Tirano→Sondrio for Como-Tirano italian). No Google Maps integration exists in this module or anywhere else in the BOS yet.

## Intake signals added in this implementation — not in the original spec, added to make deferral testable

`requestedServiceType`, `channel`, and `possibleNightOrHolidaySurcharge` on `PricingInput` are **not** calculation logic — they're minimal flags so a caller can tell the engine "this is hourly" / "this came via GetTransfer or Viator" / "this might need the night/holiday review", letting the engine defer to `manual_required` immediately and correctly instead of silently falling through the point-to-point logic. No formula, tariff, or threshold was invented for any of them — flagged here explicitly since these three fields did not exist in the approved technical plan and were added specifically to satisfy the founder-required test cases for hourly/GetTransfer/Viator/night-holiday deferral.

## Not implemented (returns `manual_required`, no value guessed)

- Hourly/disposal formula (starting prices €40/h italian, €60/h foreign are known — the rest is not)
- Night/holiday +15% surcharge (conditions not defined — every foreign booking flagged via `possibleNightOrHolidaySurcharge` defers, nothing is auto-applied)
- GetTransfer markup (base tariff definition not confirmed)
- Viator pass-through (no technical mechanism yet exists to receive the external price)
- Hospital waiting rate for foreign customers

## Not wired into anything yet

Not called from `transfer-requests`, not called from any webhook, no persistence into `transfer_requests.pricingStatus`/`calculatedAmountCents`/`pricingBreakdown`. This module is a complete, tested, standalone unit — integration is a separate, explicitly-approved next step.
