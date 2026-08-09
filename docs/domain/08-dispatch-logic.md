# Dispatch Logic

Owned by the `dispatch` module. Listens to `booking.confirmed`; emits `booking.driver_assigned`.

## Phase 1: manual assignment

The admin/dispatcher sees a list of `confirmed` bookings without a driver, and a list of candidate drivers, and assigns manually. This matches how the business runs today (WhatsApp/phone coordination) and is deliberately **not** automated yet — see [ADR 0002](../adr/0002-modular-monolith-not-microservices.md)'s general "don't build for imagined scale" stance, applied here specifically: automated matching only pays off once there are enough simultaneous bookings and drivers that manual assignment is actually the bottleneck.

## Candidate driver filtering (what the dispatcher sees)

A driver is a valid candidate for a given booking if **all** of:

1. `driver.status = 'active'`
2. `driver.is_available_now = true` (or, once shift scheduling exists in Phase 2+, available for the relevant window)
3. No **overlapping assignment**: the driver has no other `assigned | en_route | arrived | in_progress` booking whose `[scheduled_pickup_at, scheduled_pickup_at + estimated_duration_minutes + buffer]` window intersects this booking's window. `buffer` (time to travel from drop-off back to availability) is a configurable constant, not zero — a driver finishing a trip at 14:00 across town cannot start another at 14:05.
4. The assigned (or driver's primary) vehicle's `passenger_capacity`/`luggage_capacity` meets the booking's `passenger_count`/`luggage_count`.
5. Vehicle `class` matches what was quoted/booked (a client who booked and paid for a `luxury_sedan` should not be assigned a `sedan`).

This filtering logic is the one piece of "dispatch" that has real business value even in Phase 1's manual UI — it prevents the dispatcher from being shown (and picking) an invalid driver, which a spreadsheet/WhatsApp process can't reliably guarantee.

## Assignment action

Dispatcher selects a driver (and confirms/overrides the vehicle) → `dispatch` records `booking.driver_id`, `booking.vehicle_id`, transitions `confirmed → assigned`, emits `booking.driver_assigned`.

## Reassignment

A driver can be swapped after assignment (e.g. driver reports unavailable last-minute) as long as the booking hasn't reached `in_progress`. Reassignment re-runs the same candidate filtering against the new driver and re-emits `booking.driver_assigned` (triggering fresh notifications to both the old and new driver, and an updated notice to the client).

## Phase 2+: assisted matching

Once manual assignment is a real bottleneck (the trigger condition, not a calendar date — consistent with [ADR 0005](../adr/0005-defer-turborepo.md)'s pattern of "add complexity when it's felt, not preemptively"), `dispatch` can rank valid candidates instead of just listing them, using signals like:

- Proximity of the driver's current/last-known location to the pickup point (requires location data BOS doesn't collect in Phase 1).
- Driver rating/reliability (requires a rating system that doesn't exist yet).
- Load balancing across drivers (avoid always picking the same "best" driver).

This is also the natural home for the AI-assisted dispatch suggestion mentioned in [AI Automation](11-ai-automation.md) — ranking, not auto-assigning, keeping a human in the loop.

## Phase 3+: real-time/automated dispatch

Full auto-assignment without a human click, live GPS tracking, multi-stop optimization — explicitly out of scope until Phase 2's assisted matching has been used in production and the business genuinely needs it. Not designed in detail here to avoid speculative architecture for a problem that doesn't exist yet.

## Events

| Event | Fired on | Consumed by |
|---|---|---|
| `booking.driver_assigned` | Dispatcher confirms an assignment | `notifications` (driver details to client, trip details to driver) |
| `booking.reassigned` | Driver swapped post-assignment | `notifications` (updated details to client and both drivers) |
