# Notification Flows

Owned by the `notifications` module. Per [ADR 0002](../adr/0002-modular-monolith-not-microservices.md), this module only *reacts* to events emitted by other modules — it has no lifecycle of its own beyond logging what it sent (`notifications` table, see [Business Entities](01-business-entities.md)).

## Channels

| Channel | Provider | Used for |
|---|---|---|
| SMS | Twilio | Time-sensitive, high-open-rate messages (confirmations, reminders, driver-assigned) |
| Email | Resend | Receipts, invoices, anything with an attachment or that benefits from a permanent record |
| WhatsApp | (Phase 2+, provider TBD — likely Twilio's WhatsApp Business API) | Matches how clients already communicate with Bonolini Transfer today; not built in Phase 1 but the `channel` enum reserves it so it's additive later |
| Push | (Phase 2+, once the driver PWA supports it) | Driver-facing trip updates, replacing SMS for drivers once the PWA exists |

Phase 1 ships SMS + email only — sufficient to fully replace the current manual WhatsApp/email process, and avoids taking on a WhatsApp Business API integration before the core booking flow is proven.

## Event → notification map

| Trigger event | Recipient | Channel(s) | Content |
|---|---|---|---|
| `booking.confirmed` | client | email + SMS | Booking confirmation, price, pickup details |
| `booking.driver_assigned` | client | SMS | Driver name, vehicle, plate, ETA |
| `booking.driver_assigned` | driver | SMS | Trip details: pickup/dropoff, time, passenger count, special requests |
| `booking.reassigned` | client, old driver, new driver | SMS | Updated assignment |
| *(scheduled, not event-driven)* T-24h before `scheduled_pickup_at` | client | SMS | Reminder |
| *(scheduled)* T-1h before `scheduled_pickup_at` | client | SMS | "Your driver will arrive soon" |
| `booking.cancelled` | client, assigned driver (if any) | SMS + email | Cancellation notice, refund status if applicable |
| `booking.no_show` | admin | internal (email or admin dashboard alert, not client-facing) | Ops alert |
| `booking.completed` | client | email | Thank-you + receipt/invoice link |
| `payment.failed` | client | email | Retry prompt |
| `payment.refunded` | client | email | Refund confirmation |
| `billing.invoice_created` (corporate) | client (billing contact) | email | Invoice attached/linked |
| `billing.invoice_overdue` | client, admin | email | Payment reminder / internal alert |
| `driver.activated` | driver | SMS/email | Welcome + login instructions |

The two scheduled reminders (T-24h, T-1h) are **not** triggered by a domain event — they're time-based, implemented as Inngest scheduled functions that query upcoming `confirmed`/`assigned` bookings, not something `bookings` emits an event for. Worth calling out explicitly since every other row in this table is event-driven.

## Delivery tracking

Every send attempt gets a `notifications` row (`status: queued → sent → delivered/failed`, `provider_message_id` for correlating with Twilio/Resend delivery webhooks). This exists so an admin can answer "did the client actually get the confirmation?" without digging through provider dashboards — directly useful for a business currently coordinating manually over WhatsApp, where "did they see it" is often uncertain.

## Failure handling

A failed SMS (e.g. bad number) should not silently disappear — Phase 1: surface failed sends on the admin booking view so a human can follow up manually (call the client). Automatic channel fallback (SMS fails → try email) is a reasonable Phase 2 refinement, not required to replace the current fully-manual process.

## Template ownership

Message templates (`template_key` → actual copy) live in `packages/core/src/notifications`, in the language(s) Bonolini Transfer operates in (Italian primarily; confirm with the founder whether English is also needed for international clients — a real, likely-yes question given airport transfer clients, not decided here).
