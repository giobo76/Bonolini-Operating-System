# billing

**Status:** not implemented — scheduled for Phase 1.

**Owns:** invoices and Stripe payment records.

**Exposes:** create invoice, record payment.

**Emits:** `billing.invoice_created`, `billing.payment_succeeded`.

**Listens to:** `booking.completed` (from `bookings`).

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this and every other domain module follows.
