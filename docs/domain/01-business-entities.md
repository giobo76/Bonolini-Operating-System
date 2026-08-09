# Business Entities

The canonical data model for Bonolini Transfer. Every other domain document refers back to this one. Field lists here are the intended shape for Phase 1's Drizzle schema (`packages/db/src/schema/`) — one file per entity group, owned by the corresponding `packages/core` module.

All tables carry `tenant_id` (already established in Phase 0 — see [ADR 0004](../adr/0004-tenant-id-multitenancy.md)) even though it is omitted from the field lists below for brevity.

## Tenant & identity (Phase 0 — already exists)

- **Tenant** — `id, slug, name, created_at`. One row today: `bonolini-transfer`.
- **Profile** — `id (= auth.users.id), tenant_id, role, full_name, created_at`. One row per person with a login (admin, dispatcher, driver, or a client who created an account). `role` enum: `admin | dispatcher | driver | client`.

## Client

Owned by the `clients` module. A **Client is not the same as a Profile** — most bookings in an NCC business come from guests, corporate travel coordinators booking on behalf of someone else, or hotel concierges, none of whom necessarily have a login. `Client` is the business record; `Profile` is the optional login attached to it.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `profile_id` | uuid, nullable, FK → profiles.id | Set once a guest creates/claims an account. Account-claiming flow is Phase 2+. |
| `full_name` | text | |
| `email` | text, nullable | |
| `phone` | text | Primary contact channel for SMS/WhatsApp — treat as required in practice even though nullable at the schema level for corporate-booked trips where only a company contact is known. |
| `company_name` | text, nullable | Set for corporate accounts. |
| `notes` | text, nullable | Internal ops notes (e.g. "prefers Italian-speaking driver") — never shown to the client. |
| `marketing_consent` | boolean | GDPR — see [Customer Lifecycle](04-customer-lifecycle.md). |
| `created_at` | timestamptz | |

## Driver

Owned by the `drivers` module. Unlike clients, every driver **must** have a `profiles` row — they need a login for the driver app/PWA.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `profile_id` | uuid, FK → profiles.id, not null | |
| `full_name` | text | |
| `phone` | text | |
| `license_number` | text | Standard driving license. |
| `license_expiry_date` | date | |
| `ncc_license_number` | text, nullable | Italian NCC ("Noleggio Con Conducente") authorization — confirm exact required fields with the founder before Phase 1 (see [open questions](README.md#open-questions-requiring-the-founders-confirmation-before-phase-1-build-out)). |
| `primary_vehicle_id` | uuid, nullable, FK → vehicles.id | The vehicle this driver normally uses. A booking can still be assigned a different vehicle at dispatch time (captured on the booking itself, not derived from this field). |
| `status` | enum | `pending \| active \| suspended \| inactive` — see [Driver Lifecycle](03-driver-lifecycle.md). |
| `created_at` | timestamptz | |

A `driver_vehicle_assignments` join table (many-to-many, for fleets where drivers rotate vehicles) is **not** part of Phase 1 — `primary_vehicle_id` is sufficient until the fleet grows past the point where that's true. Revisit if/when it isn't.

## Vehicle

Owned by the `drivers` module (vehicles are fleet assets, not a domain of their own at this scale).

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `plate_number` | text | |
| `make` / `model` / `year` | text / text / int | |
| `class` | enum | `sedan \| suv \| van \| luxury_sedan` — drives pricing (see [Pricing Engine](05-pricing-engine.md)) and client-facing vehicle selection. |
| `passenger_capacity` | int | |
| `luggage_capacity` | int | |
| `insurance_expiry_date` | date | |
| `status` | enum | `active \| maintenance \| retired` |
| `created_at` | timestamptz | |

## Booking

Owned by the `bookings` module — the central entity of the whole system. See [Booking Lifecycle](02-booking-lifecycle.md) for the state machine.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `client_id` | uuid, FK → clients.id | |
| `driver_id` | uuid, nullable, FK → drivers.id | Null until dispatched. |
| `vehicle_id` | uuid, nullable, FK → vehicles.id | Captured at assignment time — may differ from the driver's `primary_vehicle_id`. |
| `status` | enum | See [Booking Lifecycle](02-booking-lifecycle.md). |
| `service_type` | enum | `point_to_point \| hourly_disposal \| airport_transfer \| long_distance` |
| `pickup_address` / `pickup_lat` / `pickup_lng` | text / numeric / numeric | |
| `dropoff_address` / `dropoff_lat` / `dropoff_lng` | text / numeric / numeric | Nullable for `hourly_disposal` (open-ended itinerary). |
| `scheduled_pickup_at` | timestamptz | |
| `estimated_duration_minutes` / `estimated_distance_km` | int / numeric | From Google Maps at quote time; not re-derived later (see Pricing Engine on price snapshotting). |
| `passenger_count` / `luggage_count` | int / int | |
| `flight_number` | text, nullable | For `airport_transfer` — enables flight-tracking-based pickup time adjustment (Phase 2+ AI/automation opportunity, see [AI Automation](11-ai-automation.md)). |
| `special_requests` | text, nullable | Free text today; a candidate for AI-assisted structuring later. |
| `price_breakdown` | jsonb | Snapshot of the computed price at confirmation time — see [Pricing Engine](05-pricing-engine.md) for why this must never be recomputed retroactively. |
| `source` | enum | `web \| phone \| whatsapp \| admin \| corporate_portal` |
| `cancellation_reason` | text, nullable | |
| `confirmed_at` / `cancelled_at` / `completed_at` | timestamptz, nullable | |
| `created_at` / `updated_at` | timestamptz | |

## Pricing: Rate Card

Owned by the `bookings` module (pricing is intrinsic to how a booking's price is quoted, not a separate domain). See [Pricing Engine](05-pricing-engine.md).

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `name` | text | e.g. "Standard Sedan — Point to Point" |
| `service_type` | enum | Matches `booking.service_type`. |
| `vehicle_class` | enum | Matches `vehicle.class`. |
| `base_fare` | numeric | |
| `per_km_rate` / `per_minute_rate` | numeric / numeric | |
| `minimum_fare` | numeric | |
| `night_surcharge_pct` / `holiday_surcharge_pct` | numeric | |
| `active` | boolean | |
| `effective_from` | date | |
| `created_at` | timestamptz | |

## Invoice & Invoice Line Item

Owned by the `billing` module. See [Invoicing](07-invoicing.md).

**Invoice:** `id, client_id, invoice_number (per-tenant sequential), status (draft|sent|paid|overdue|void), issue_date, due_date, subtotal, tax_amount, total, currency, sdi_transmission_status (nullable), created_at`

**InvoiceLineItem:** `id, invoice_id, booking_id (nullable), description, quantity, unit_price, amount`

One invoice can cover many bookings (corporate monthly billing) via multiple line items — see [Invoicing](07-invoicing.md).

## Payment

Owned by the `billing` module. See [Payments](06-payments.md).

`id, booking_id (nullable), invoice_id (nullable), method (card|cash|invoice_account), stripe_payment_intent_id (nullable), amount, currency, status (pending|succeeded|failed|refunded|partially_refunded), paid_at (nullable), created_at`

## Notification (log)

Owned by the `notifications` module. See [Notification Flows](10-notifications.md).

`id, event_name, channel (sms|email|whatsapp|push), recipient_type (client|driver|admin), recipient_id, related_booking_id (nullable), template_key, status (queued|sent|delivered|failed), provider_message_id (nullable), sent_at (nullable), created_at`

## Consent Record

Owned by the `clients` module — GDPR requirement, not optional. See [Customer Lifecycle](04-customer-lifecycle.md).

`id, client_id, consent_type (marketing|data_processing|whatsapp_communication), granted (boolean), granted_at, source, created_at`

## Relationships at a glance

See the full [Database ERD](12-database-erd.md) for the diagram. In short: a `Client` has many `Bookings`; a `Booking` optionally has one `Driver` and one `Vehicle`; a `Driver` optionally has one primary `Vehicle`; an `Invoice` has many `InvoiceLineItems`, each optionally pointing at a `Booking`; a `Booking` or `Invoice` has many `Payments`.
