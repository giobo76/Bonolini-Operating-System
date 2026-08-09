# API Contracts

Per [CLAUDE.md](../../CLAUDE.md#tech-stack), the API layer is **tRPC** — type-safe procedures generated from `packages/core`, not a hand-maintained REST/OpenAPI spec. This document defines the procedure surface each module will expose in Phase 1, as a contract to build against — not implementation.

Two exceptions need plain HTTP routes, not tRPC, because external services call them directly:

- `POST /api/webhooks/stripe` — Stripe payment events (see [Payments](06-payments.md)).
- `POST /api/webhooks/inngest` — Inngest's function-invocation endpoint (framework requirement, not domain-specific).

## Router shape

Each `packages/core` module exposes one tRPC router, merged into a root router consumed by both apps. Naming: `<module>.<action>`.

### `bookings`

| Procedure | Input (shape) | Output | Auth |
|---|---|---|---|
| `bookings.quote` | pickup, dropoff\|duration, serviceType, vehicleClass, scheduledPickupAt | `price_breakdown` (unsaved) | public (guests can quote) |
| `bookings.create` | quote inputs + client contact info + passenger/luggage counts | `Booking` (status `draft`) | public |
| `bookings.confirm` | `bookingId`, payment confirmation reference | `Booking` (status `confirmed`) | client (own) / admin |
| `bookings.cancel` | `bookingId`, `reason` | `Booking` (status `cancelled`) | client (own) / admin / dispatcher |
| `bookings.get` | `bookingId` | `Booking` | client (own) / driver (own assigned) / admin / dispatcher |
| `bookings.list` | filters (status, date range, clientId, driverId) | `Booking[]` | scoped by role per [Roles & Permissions](09-roles-permissions.md) |
| `bookings.updateStatus` | `bookingId`, `status` (`en_route\|arrived\|in_progress\|completed\|no_show`) | `Booking` | driver (own assigned) / admin |
| `bookings.overridePrice` | `bookingId`, `newTotal`, `reason` | `Booking` | admin / dispatcher |

### `dispatch`

| Procedure | Input | Output | Auth |
|---|---|---|---|
| `dispatch.candidates` | `bookingId` | `Driver[]` (filtered per [Dispatch Logic](08-dispatch-logic.md)) | admin / dispatcher |
| `dispatch.assign` | `bookingId`, `driverId`, `vehicleId` | `Booking` (status `assigned`) | admin / dispatcher |
| `dispatch.reassign` | `bookingId`, `newDriverId`, `newVehicleId` | `Booking` | admin / dispatcher |

### `drivers`

| Procedure | Input | Output | Auth |
|---|---|---|---|
| `drivers.create` | driver + initial vehicle details | `Driver` (status `pending`) | admin |
| `drivers.approve` | `driverId` | `Driver` (status `active`) | admin |
| `drivers.suspend` | `driverId`, `reason` | `Driver` | admin |
| `drivers.setAvailability` | `isAvailableNow` | `Driver` | driver (self) |
| `drivers.list` | filters (status) | `Driver[]` | admin / dispatcher |
| `drivers.get` | `driverId` | `Driver` | admin / dispatcher / driver (self) |

### `clients`

| Procedure | Input | Output | Auth |
|---|---|---|---|
| `clients.upsertGuest` | contact info | `Client` | public (called internally by `bookings.create`) |
| `clients.claimAccount` | email verification token | `Client` (linked `profile_id`) | authenticated (new account) |
| `clients.updateConsent` | `consentType`, `granted` | `ConsentRecord` | client (self) |
| `clients.get` / `clients.list` | — | `Client` / `Client[]` | admin / dispatcher, or client (self) |
| `clients.blocklist` | `clientId`, `reason` | `Client` | admin |

### `billing`

| Procedure | Input | Output | Auth |
|---|---|---|---|
| `billing.createInvoice` | `clientId`, `bookingIds[]` | `Invoice` | admin (corporate consolidated) / system (auto, per-booking receipts) |
| `billing.getInvoice` / `billing.listInvoices` | — | `Invoice` / `Invoice[]` | admin, or client (own) |
| `billing.refund` | `paymentId`, `amount`, `reason` | `Payment` | admin |

### `notifications`

| Procedure | Input | Output | Auth |
|---|---|---|---|
| `notifications.listForBooking` | `bookingId` | `Notification[]` | admin / dispatcher |

No `send` procedure — sends are triggered exclusively by Inngest event listeners reacting to other modules' events (see each lifecycle doc's "Events emitted" table), never called directly by client code. This is the tRPC-layer expression of the module boundary rule in [ADR 0002](../adr/0002-modular-monolith-not-microservices.md).

## Validation

Every procedure's input is a Zod schema, colocated with the router (see [Folder Conventions](../engineering/01-folder-conventions.md)) — this is also the boundary where external input is validated, per the project's general engineering conventions (validate at system boundaries, trust internal code beyond that).

## Errors

tRPC's typed error codes (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `BAD_REQUEST`, `CONFLICT`) map directly onto this domain: `CONFLICT` for e.g. attempting to assign an already-overlapping driver ([Dispatch Logic](08-dispatch-logic.md)), `FORBIDDEN` for role/ownership violations caught at the app layer (RLS would also block these at the DB layer — see [Roles & Permissions](09-roles-permissions.md)).

## Webhook contracts (non-tRPC)

**`POST /api/webhooks/stripe`** — verifies Stripe signature, handles `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`. Delegates to `billing`'s internal service functions (not through tRPC, since this isn't a client-authenticated call) — see [Payments](06-payments.md).

**`POST /api/webhooks/inngest`** — standard Inngest serve handler, registers the `functions` array from `packages/jobs` (empty as of Phase 0, populated per-module starting Phase 1).
