# availability — vehicle readiness, never a calendar itself

**Status:** Core v1 (pure feasibility arithmetic, below) plus, since 2026-09-26, the **busy window** of a service and the **overlap check** shown in PREVENTIVO PRONTO — see "Busy window and overlap check" right below. The v1 feasibility functions are unchanged and still not wired into any workflow.

**Owns:** nothing persistent — same discipline as `maps-distance`. Every export is a pure, synchronous function; same input always produces the same output, no side effects.

**Exposes:** `isServiceFeasible`, `estimateVehicleFreeAt`, `calculateServiceEndAt`, `calculateVehicleReadyAt`, `determineRelocationOrigin`, plus every type/constant in `schema.ts` (`BASE_LOCATION`, `OPERATIONAL_BUFFER_MINUTES`); the busy-window functions (`computeBusyWindow`, `findRouteMinimum`, `computeServiceBusyWindow`, the stored-window (de)serializers) and `findOverlaps`.

**Emits / Listens to:** — (pure module, not wired into any event flow or the WhatsApp pipeline).

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this and every other domain module follows.

## Busy window and overlap check (founder decisions 2026-09-25/26)

Before this, "Disponibilità: compatibile con gli altri servizi" was printed for every request: the only caller always passed "no previous service", so nothing was ever compared. Now:

**Busy window of a service** (`busy-window.ts` pure, `service-window.ts` with I/O): the whole time the founder is busy, the loop Sondrio → pickup → destination → Sondrio from Google Maps (`maps-distance`'s `calculateBusyLoopFromBase`), starting when he leaves Sondrio, rounded outward to 5 minutes. Route minimums come from the versioned Business Rule `calendar.minimum_event_duration` (migration 0031: Malpensa, both directions, 5 hours). Without Maps: pickup time + 2 hours (never less than the route minimum), flagged "da verificare". No extra buffer: the loop already includes the return to Sondrio. The pickup time is the customer's wall clock in Europe/Rome (`dates.ts`'s `romeWallClockToUtc`), never the server's timezone. The same function feeds the Google Calendar event, so the calendar and the check always agree.

**Where it is stored.** Computed for a request when its PREVENTIVO PRONTO goes out, and copied on the booking at Approva (`bookings.busy_window`, migration 0032). A booking created before that has none: it counts as pickup time + 2 hours, "da verificare".

**Overlap check** (`findOverlaps`, pure; gathered by quote-approval's `availability-check.ts`): the new request's busy window is compared with
- BOS bookings `pending_deposit`, `pending_confirmation` and `confirmed` around it (services across midnight included);
- the events of the Google Calendar selected in the panel, read live (read-only): personal and all-day events too; events marked "Libero" and events created by BOS are skipped (the booking itself is compared). A booking imported from Calendar is compared through its event, never twice.

Two windows overlap when one starts before the other ends. Back-to-back services (drop at Malpensa, next pickup at Malpensa) are flagged too (founder decision): the founder decides, BOS never blocks or refuses anything.

## Source of truth

Recovered from **nothing** — this is the one piece of this codebase's CChiefGrowthAI-recovery lineage that is genuinely new. The audit (see the founder-facing report from this milestone) found no working version of "vehicle position + relocation time" logic anywhere in the old project, at any of its three layers:

- The live bot (`ai/booking_bot/calendar_checker.py`) only ever listed a day's events as text for the admin — no conflict detection, no position tracking.
- The disconnected experimental layer (`ai/communication/engines/travel_time_engine.py`) computed calendar-gap margins between adjacent events, but never read the adjacent event's `location` field (it was captured in the data model, never consumed) and its own "travel time" input was a permanent stub returning `0`.
- A third, stub layer (`ai/intelligence/chief_booking_ai/calendar/calendar_engine.py`) always returned `disponibile: True`, unconditionally.

Every formula here is a direct implementation of the founder's own commercial rules for this milestone, not a port of anything that previously worked.

## What this module does NOT do

Deliberately, by design:

- Does not call Google Maps. Every `*DurationMinutes` input is already resolved by the caller — see "Callers must supply durations" below.
- Does not call Google Calendar. Has no concept of an "event," only of a `previousService`/`candidate` pair the caller already knows about.
- Does not decide a price, a customer type, or anything pricing-related (`packages/core/src/pricing` owns all of that, untouched by this milestone).
- Does not persist anything — no `transfer_requests`, `bookings`, or `quotes` access, no database import at all.
- Does not branch on a place name. There is no `if destination === "Malpensa"` anywhere in `service.ts` — the formula is `previousDestination -> candidatePickup`, generic for every pair of strings. The **only** hardcoded location is `BASE_LOCATION` (`"Sondrio"`), used exclusively as the origin when `previousService` is `null` — not as a special case in the math, just the honest absence of a real previous position.

## Two different questions, one shared formula

`isServiceFeasible` and `estimateVehicleFreeAt` answer different questions but are built from the same two primitives (`calculateServiceEndAt`, `calculateVehicleReadyAt`), so the "add a duration, then add the buffer" arithmetic is never implemented twice:

- **`isServiceFeasible(candidate, previousService, relocationDurationMinutes?)`** — "is *this specific* candidate service feasible, given what the vehicle was doing right before it?" Used once a next service is already known.
- **`estimateVehicleFreeAt(candidate, customerTripDurationMinutes, returnToBaseDurationMinutes)`** — "roughly when is the vehicle free again, in general, assuming it returns to base?" Used when no next service is known yet — this is the worked example in the spec (Sondrio → Malpensa → back to Sondrio → +buffer).

### The formula

```
previousServiceEndAt = previousService.startAt + previousService.customerTripDurationMinutes
relocationOrigin      = previousService ? previousService.destination : BASE_LOCATION   ("Sondrio")
vehicleReadyAt         = previousServiceEndAt + relocationDurationMinutes + OPERATIONAL_BUFFER_MINUTES (60)
feasible               = vehicleReadyAt <= candidate.startAt
marginMinutes           = candidate.startAt - vehicleReadyAt
```

`estimateVehicleFreeAt` is the exact same `endAt + relocation + buffer` shape, just with the candidate's own trip as the "previous" leg and `BASE_LOCATION` as the fixed relocation target:

```
serviceEndAt           = candidate.startAt + customerTripDurationMinutes
estimatedVehicleFreeAt = serviceEndAt + returnToBaseDurationMinutes + OPERATIONAL_BUFFER_MINUTES
```

No `if` on distance, on airport, on "is this a long trip" — every one of the five scenarios in the spec (return-to-base, back-to-back same location, different next pickup, and both post-hoc cases) is the same formula with different `relocationOrigin`/`relocationDurationMinutes` inputs, never a special case in the code.

## Two duration concepts that must never merge

- **`customerTripDurationMinutes`** — pickup → destination, for a service the vehicle is actually running with a paying customer aboard.
- **`vehicleRelocationDurationMinutes`** (or `returnToBaseDurationMinutes`) — an empty leg, a different origin/destination pair entirely (`previousService.destination → candidate.pickup`, or `candidate.destination → BASE_LOCATION`). Never the same Maps call as the one above, never merged into a single number — collapsing them would make it impossible to show an admin *why* a service is or isn't feasible.

`operationalBufferMinutes` is a third, separate concept — a commercial-policy constant (`60`, founder-confirmed), never computed from Maps, never a caller-supplied override in this v1 (same convention as `pricing/service.ts`'s `MINIMUM_FARE_CENTS`/`TOLL_RATE_PER_KM`: a policy value lives inside the engine, is always reported in the result, but is never an input a caller can silently change).

## Callers must supply durations — this module never calls Maps

`packages/core/src/maps-distance` already exports everything a future caller needs: `calculateRoute(waypoints)` returns `durationMinutes` for an arbitrary two-point (or multi-point) route — exactly the shape both `customerTripDurationMinutes` and `vehicleRelocationDurationMinutes`/`returnToBaseDurationMinutes` need. No new export was added to `maps-distance` for this milestone (and none was needed): `determineRelocationOrigin(previousService)` tells a future caller *what* to pass into `calculateRoute` (either `previousService.destination` or `BASE_LOCATION`, paired with `candidate.pickup`); the caller makes that Maps call itself, then hands the resulting `durationMinutes` into `isServiceFeasible`/`estimateVehicleFreeAt`.

## Extensibility: multiple vehicles, later

`PreviousService`/`CandidateService` both carry an optional `resourceId` field, unused by every function in this module today (BOS runs a single vehicle/driver) — carried through only so a future multi-vehicle version can filter "the previous service for *this* resource" before calling this same engine, without reshaping these types or rewriting the formula.

## Structured result, never free text

`ServiceFeasibilityResult.reason` is a closed union (`"no_previous_service" | "within_operational_margin" | "insufficient_operational_margin"`), not a string an admin (or future UI) has to parse. Every duration that went into the decision (`customerTripDurationMinutes`, `vehicleRelocationDurationMinutes`, `operationalBufferMinutes`) is reported alongside `vehicleReadyAt`/`marginMinutes`, so the *why* is always reconstructable from the result object alone.

## Not built yet (explicitly out of scope this milestone)

(Since 2026-09-26 the overlap check above calls Maps, the database and Calendar through its own files; the v1 feasibility functions below stay pure.)

Google Calendar (reading real events, OAuth/service-account decision), Google Maps calls (the caller's responsibility, not built here), any connection to `transfer_requests`/`bookings`/`quotes`, any database access, any tRPC router, any WhatsApp/email wiring, any admin notification, any UI. See the founder-facing availability audit for the proposed order these arrive in.
