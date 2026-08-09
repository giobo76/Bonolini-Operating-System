# Database ERD

Visual companion to [Business Entities](01-business-entities.md) — field-level detail lives there; this is the relationship map. `tenant_id` is on every table (see [ADR 0004](../adr/0004-tenant-id-multitenancy.md)) but omitted from the diagram for readability.

```mermaid
erDiagram
    TENANTS ||--o{ PROFILES : "has"
    PROFILES ||--o| CLIENTS : "optionally is"
    PROFILES ||--o| DRIVERS : "optionally is"

    CLIENTS ||--o{ BOOKINGS : "makes"
    CLIENTS ||--o{ CONSENT_RECORDS : "grants"
    CLIENTS ||--o{ INVOICES : "billed via"

    DRIVERS ||--o| VEHICLES : "primary vehicle"
    DRIVERS ||--o{ BOOKINGS : "assigned to"

    VEHICLES ||--o{ BOOKINGS : "used for"

    RATE_CARDS ||--o{ BOOKINGS : "prices (snapshotted)"

    BOOKINGS ||--o{ INVOICE_LINE_ITEMS : "billed as"
    BOOKINGS ||--o{ PAYMENTS : "paid via"
    BOOKINGS ||--o{ NOTIFICATIONS : "triggers"

    INVOICES ||--o{ INVOICE_LINE_ITEMS : "contains"
    INVOICES ||--o{ PAYMENTS : "paid via"

    TENANTS {
        uuid id PK
        text slug
        text name
    }
    PROFILES {
        uuid id PK
        uuid tenant_id FK
        enum role
        text full_name
    }
    CLIENTS {
        uuid id PK
        uuid profile_id FK "nullable"
        text full_name
        text email
        text phone
        text company_name
        boolean marketing_consent
    }
    DRIVERS {
        uuid id PK
        uuid profile_id FK
        text license_number
        date license_expiry_date
        text ncc_license_number
        uuid primary_vehicle_id FK "nullable"
        enum status
    }
    VEHICLES {
        uuid id PK
        text plate_number
        enum class
        int passenger_capacity
        int luggage_capacity
        enum status
    }
    BOOKINGS {
        uuid id PK
        uuid client_id FK
        uuid driver_id FK "nullable"
        uuid vehicle_id FK "nullable"
        enum status
        enum service_type
        timestamptz scheduled_pickup_at
        jsonb price_breakdown
        enum source
    }
    RATE_CARDS {
        uuid id PK
        enum service_type
        enum vehicle_class
        numeric base_fare
        numeric per_km_rate
        numeric per_minute_rate
        numeric minimum_fare
        boolean active
    }
    INVOICES {
        uuid id PK
        uuid client_id FK
        text invoice_number
        enum status
        numeric total
    }
    INVOICE_LINE_ITEMS {
        uuid id PK
        uuid invoice_id FK
        uuid booking_id FK "nullable"
        text description
        numeric amount
    }
    PAYMENTS {
        uuid id PK
        uuid booking_id FK "nullable"
        uuid invoice_id FK "nullable"
        enum method
        enum status
        numeric amount
    }
    NOTIFICATIONS {
        uuid id PK
        uuid related_booking_id FK "nullable"
        enum channel
        enum status
    }
    CONSENT_RECORDS {
        uuid id PK
        uuid client_id FK
        enum consent_type
        boolean granted
    }
```

## Notes on relationships that aren't purely structural

- **`PROFILES ||--o| CLIENTS` and `PROFILES ||--o| DRIVERS` are both "optionally is," not "has."** A `profile` with `role = client` may or may not have a linked `clients` row depending on whether that person has ever booked — and a guest `clients` row may exist with **no** `profiles` row at all (see [Customer Lifecycle](04-customer-lifecycle.md)). This is the one place the diagram is easy to misread as a strict hierarchy; it isn't.
- **`RATE_CARDS ||--o{ BOOKINGS`" is a snapshot relationship, not a live one.** `booking.price_breakdown` freezes the computed price at confirmation time; `rate_card_id` is kept for traceability only (see [Pricing Engine](05-pricing-engine.md#why-the-result-is-a-frozen-snapshot-not-a-live-calculation)). Changing a rate card never changes an existing booking's price.
- **`BOOKINGS ||--o{ INVOICE_LINE_ITEMS`" is many-to-many at the invoice level** even though each line item points at one booking — one booking generates one line item (its own receipt), but one invoice can aggregate line items from many bookings (corporate consolidated billing). See [Invoicing](07-invoicing.md).
- **Row Level Security**, not shown in this diagram, additionally scopes every table by `tenant_id`, and (per [Roles & Permissions](09-roles-permissions.md)) will scope `bookings`/`drivers`/`clients` further by role in Phase 1 — a `driver` only sees rows where `driver_id` matches their own `drivers.id`, a `client` only sees rows where `client_id` matches their own.
