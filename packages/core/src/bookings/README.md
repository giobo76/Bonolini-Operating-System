# bookings

**Status:** minimal skeleton, implemented 2026-08-06 as part of the Marketing Intelligence Engine's funnel-attribution work (Click → Lead → Quote → Deposit → Confirmed booking → Completed service → Invoice → Payment). Status + money + client link only — **not** the full lifecycle below yet.

**Owns:** `bookings` (id, tenant_id, client_id, quote_id, status, currency, deposit/final/invoice/paid amounts in cents, deposit_paid_at, scheduled_at, completed_at, cancelled_at, invoiced_at, paid_at). Current `status` enum is deliberately just `confirmed | completed | cancelled` — the full dispatch-aware state machine documented in docs/domain/02-booking-lifecycle.md (`draft → confirmed → assigned → en_route → arrived → in_progress → completed`, with dispatch/driver assignment) is **not implemented**. This table is meant to grow into that feature when Booking Management is properly built, not be replaced by it.

**Exposes:** `bookings.create`, `bookings.listForClient`, `bookings.get`, `bookings.update` (a single flexible patch mutation covering every milestone — deposit paid, completed, cancelled, invoiced, paid — since there's no dedicated Booking Management UI yet, just admin actions from the customer detail page).

**Invoice/payment** are flattened onto this table for now (`invoiced_at`/`invoice_amount_cents`/`paid_at`/`paid_amount_cents`) rather than separate Invoicing/Payments tables — enough for funnel attribution without building those full features ahead of their turn on the roadmap.

**Emits:** — (no cross-module events yet — will emit `booking.confirmed`/`booking.completed`/etc. once dispatch/notifications modules exist to react to them, per docs/domain/02-booking-lifecycle.md's events table)

**Listens to:** —

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this and every other domain module follows.
