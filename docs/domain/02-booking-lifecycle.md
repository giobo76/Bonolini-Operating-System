# Booking Lifecycle

Owned by the `bookings` module. This refines the state machine already referenced in `packages/core/src/bookings/README.md` (`draft → confirmed → assigned → in_progress → completed → cancelled`) with the detail needed to actually implement it.

## States

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> confirmed: client/admin confirms + payment captured (if required)
    draft --> cancelled: abandoned quote
    confirmed --> assigned: dispatcher assigns driver + vehicle
    confirmed --> cancelled: cancelled before assignment
    assigned --> en_route: driver marks "heading to pickup"
    assigned --> cancelled: cancelled after assignment (driver freed)
    en_route --> arrived: driver marks "arrived at pickup"
    arrived --> in_progress: passenger onboard
    arrived --> no_show: passenger doesn't show within grace period
    in_progress --> completed: driver marks trip complete
    completed --> [*]
    cancelled --> [*]
    no_show --> [*]
```

| Status | Meaning | Who can trigger |
|---|---|---|
| `draft` | Quote generated, not yet a confirmed commitment. | client (web flow), admin (phone booking) |
| `confirmed` | Client has committed; payment captured or invoice-account approved. | client, admin |
| `assigned` | Driver + vehicle assigned. | dispatcher/admin (Phase 1: manual — see [Dispatch Logic](08-dispatch-logic.md)) |
| `en_route` | Driver is travelling to the pickup location. | driver (via PWA) |
| `arrived` | Driver is at the pickup location, waiting. | driver |
| `in_progress` | Passenger is in the vehicle, trip underway. | driver |
| `completed` | Trip finished. Triggers billing (see below). | driver |
| `cancelled` | Booking will not happen. Requires `cancellation_reason`. | client, admin, (driver-initiated cancellation routes through admin) |
| `no_show` | Client did not appear at pickup within the grace period. | driver, confirmed by admin |

`en_route` / `arrived` are **Phase 2** granularity (they require the driver PWA to exist). Phase 1 ships with `assigned → in_progress → completed` only, with `en_route`/`arrived` reserved in the enum from the start so Phase 2 doesn't need a schema migration to add them — it needs UI to set them.

## Guard conditions

- `draft → confirmed` requires: pickup/dropoff (or disposal duration) set, `scheduled_pickup_at` in the future, and payment success **or** an approved corporate `invoice_account` (see [Payments](06-payments.md)).
- `confirmed → assigned` requires: an `active` driver with no overlapping assignment in the pickup time window (± estimated trip duration + buffer — see [Dispatch Logic](08-dispatch-logic.md)), and an `active` vehicle of adequate `passenger_capacity`/`luggage_capacity`.
- `arrived → no_show`: only after a configurable grace period past `scheduled_pickup_at` (business rule TBD with the founder — see [Payments](06-payments.md#cancellation--refund-policy) for the related charge policy).
- Any transition **into** `cancelled` requires `cancellation_reason`.
- Terminal states (`completed`, `cancelled`, `no_show`) are immutable — no further status transitions. Corrections (e.g. a mis-marked no-show) are an admin data-fix, not a lifecycle transition, and should be logged as such if/when an audit log exists.

## Events emitted (consumed by other modules via Inngest)

Per [ADR 0002](../adr/0002-modular-monolith-not-microservices.md), these are the only way other modules react to a booking's lifecycle:

| Event | Fired on transition | Consumed by |
|---|---|---|
| `booking.created` | entry into `draft` | — (mostly for analytics/audit later) |
| `booking.confirmed` | `draft → confirmed` | `dispatch` (becomes assignable), `notifications` (confirmation message) |
| `booking.driver_assigned`\* | `confirmed → assigned` | `notifications` (driver details to client, trip details to driver) |
| `booking.completed` | `in_progress → completed` | `billing` (generate invoice/receipt line item), `notifications` (thank-you/receipt) |
| `booking.cancelled` | any state `→ cancelled` | `notifications` (cancellation notice), `billing` (refund evaluation) |
| `booking.no_show` | `arrived → no_show` | `notifications` (internal alert), `billing` (no-show charge evaluation) |

\* Note: this event is actually emitted by `dispatch`, not `bookings`, since dispatch owns the assignment action — listed here for lifecycle completeness. See [module boundaries](../../CLAUDE.md#module-boundary-rule-packagescore).

## Price snapshotting

`price_breakdown` is computed once at `draft` creation (or re-quoted if the client changes pickup/dropoff/time before confirming) and frozen at `confirmed`. It is never recalculated after that point, even if the underlying rate card changes — see [Pricing Engine](05-pricing-engine.md) for why.

## Cancellation windows

Whether a cancellation is free, partially charged, or fully charged depends on how close to `scheduled_pickup_at` it happens. The actual thresholds are a business decision, not an engineering one — see [Payments](06-payments.md#cancellation--refund-policy) for the flagged open question.
