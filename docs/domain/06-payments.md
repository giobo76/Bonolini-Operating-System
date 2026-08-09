# Payments

Owned by the `billing` module.

## Payment methods

| Method | When used | Mechanism |
|---|---|---|
| `card` | Individual/guest bookings, paid upfront at confirmation | Stripe Checkout/Elements — card data never touches BOS servers (PCI SAQ-A scope, per [security strategy](../../CLAUDE.md)) |
| `cash` | Client pays the driver directly at trip end | Recorded manually by the driver (PWA) or admin after the fact; no Stripe involvement |
| `invoice_account` | Corporate clients with a billing arrangement | No payment captured at booking time — the booking is confirmed on trust, billed later via a consolidated [invoice](07-invoicing.md) |

## Booking confirmation payment flow (`card`)

1. Client reaches `draft` with a computed `price_breakdown`.
2. Client proceeds to pay → Stripe PaymentIntent created for `price_breakdown.total`.
3. Stripe webhook `payment_intent.succeeded` → `billing` records a `payments` row (`status: succeeded`) → emits an internal signal that lets `bookings` transition `draft → confirmed` (see [Booking Lifecycle](02-booking-lifecycle.md)).
4. `payment_intent.payment_failed` → booking stays in `draft`; client is shown the failure and can retry.

Note: the Stripe webhook is necessarily a plain HTTP endpoint (`POST /api/webhooks/stripe`), not a tRPC procedure — see [API Contracts](13-api-contracts.md).

## Deposits vs. full payment

Phase 1 defaults to **full payment at confirmation** for `card` bookings — simplest to build and matches "replace the manual process" urgency. Partial deposits (e.g. 20% now, balance to the driver) are a plausible Phase 2 addition if the founder's current practice actually uses them — **not assumed here**, confirm against current manual practice before building.

## Cancellation & refund policy

The policy shape is modeled; the actual numbers are a business decision, not an engineering one, and are **flagged as needing the founder's input**:

- A cancellation more than `X` hours before `scheduled_pickup_at` → full refund.
- A cancellation between `Y` and `X` hours before → partial refund (percentage TBD).
- A cancellation less than `Y` hours before, or a `no_show` → no refund (full charge).

These thresholds should live in a settings/config table (per-tenant, so different thresholds could apply to different service types later), not be hardcoded — but the values themselves are not invented in this document.

## Refund execution

A refund is a Stripe refund API call against the original PaymentIntent, recorded as a `payments` row update (`status: refunded` or `partially_refunded`). Refunds for `cash`/`invoice_account` bookings are manual bookkeeping adjustments, not a Stripe operation.

## Payouts to drivers

Out of scope for Phase 1. Bonolini Transfer's drivers are presumably paid through existing arrangements (salary, per-trip settlement outside the platform) — building a driver payout/marketplace system is a materially different (and much larger) piece of work than "software to replace WhatsApp/spreadsheet booking management," and should only be scoped if the founder actually wants BOS to handle driver pay, not assumed as implied by having a `drivers` module.

## Events emitted

| Event | Fired on | Consumed by |
|---|---|---|
| `payment.succeeded` | Stripe webhook confirms | `bookings` (`draft → confirmed`), `notifications` (receipt) |
| `payment.failed` | Stripe webhook reports failure | `notifications` (retry prompt to client) |
| `payment.refunded` | Refund processed | `notifications` (refund confirmation), `invoicing` (credit note — see [Invoicing](07-invoicing.md)) |
