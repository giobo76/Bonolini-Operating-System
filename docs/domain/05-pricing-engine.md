# Pricing Engine

Owned by the `bookings` module (pricing is intrinsic to producing a booking quote, not a separate domain — see [Business Entities](01-business-entities.md)).

## Inputs

1. `service_type` (`point_to_point | hourly_disposal | airport_transfer | long_distance`)
2. Vehicle `class` selected or requested (`sedan | suv | van | luxury_sedan`)
3. Pickup/dropoff coordinates → distance (km) and duration (minutes) from Google Maps Distance Matrix
4. `scheduled_pickup_at` → determines night/holiday surcharge applicability
5. The active `rate_card` matching (`service_type`, `vehicle_class`)

## Computation

```
base = rate_card.base_fare
distance_fare = rate_card.per_km_rate * estimated_distance_km
time_fare = rate_card.per_minute_rate * estimated_duration_minutes
subtotal = base + distance_fare + time_fare
surcharge = subtotal * (night_pct_if_applicable + holiday_pct_if_applicable)
total_before_min = subtotal + surcharge
total = max(total_before_min, rate_card.minimum_fare)
```

`hourly_disposal` bookings use a different shape: `rate_card.per_minute_rate * requested_duration_minutes` with no distance component (the itinerary is open-ended within the booked hours) — the formula above describes `point_to_point`/`airport_transfer`/`long_distance`.

Tax (Italian VAT — IVA) is applied on top and stored as a separate `tax` line in `price_breakdown`, not folded into `total` opaquely — needed for correct invoicing (see [Invoicing](07-invoicing.md)).

## Why the result is a frozen snapshot, not a live calculation

`booking.price_breakdown` (see [Business Entities](01-business-entities.md)) stores the **full computed breakdown at confirmation time**: `{ base, distance_fare, time_fare, surcharges: [...], subtotal, tax, total, currency, rate_card_id, computed_at }`.

This is deliberate: if a rate card changes six months from now, every historical booking must still show the price the client actually agreed to and paid — recomputing from the current rate card would silently rewrite financial history. The `rate_card_id` reference is kept for traceability/audit, not for recomputation.

## Manual overrides

Admins can override the computed total on a specific booking (e.g. a negotiated corporate rate, a goodwill discount) before confirmation. The override reason should be captured as free text alongside the override — this becomes an audit-trail requirement once real money and real clients are involved, not an optional nicety.

## Corporate / negotiated rates

Phase 1 ships a single set of `rate_cards` per `service_type` × `vehicle_class`. Per-corporate-client negotiated rates (a rate card scoped to a specific `client_id`) are a **Phase 2+** extension of the same `rate_cards` table (add a nullable `client_id` column, prefer the most specific match) — not a redesign, just not built yet.

## Currency

EUR only. No multi-currency support planned — out of scope unless the business itself expands outside the eurozone, which is not a near-term assumption.

## Open question

None blocking Phase 1 — the actual `base_fare`/`per_km_rate`/`per_minute_rate`/`minimum_fare` numbers per vehicle class come from the founder's current (manual) pricing, not invented here.
