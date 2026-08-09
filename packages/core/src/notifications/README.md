# notifications

**Status:** not implemented — scheduled for Phase 1.

**Owns:** SMS/email templates and sending (Twilio / Resend).

**Exposes:** `send(template, recipient)`.

**Emits:** —

**Listens to:** `booking.confirmed` (from `bookings`), `dispatch.driver_assigned` (from `dispatch`), `billing.invoice_created` (from `billing`).

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this and every other domain module follows.
