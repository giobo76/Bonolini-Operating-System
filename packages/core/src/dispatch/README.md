# dispatch

**Status:** not implemented — scheduled for Phase 1 (manual assignment UI first; automated matching is a later refinement).

**Owns:** driver-to-booking assignment.

**Exposes:** assign / reassign driver, availability queries.

**Emits:** `dispatch.driver_assigned`.

**Listens to:** `booking.confirmed` (from `bookings`).

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this and every other domain module follows.
