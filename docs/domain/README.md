# Bonolini Transfer — Domain Blueprint

This is the business/software blueprint for Bonolini Transfer, written before Phase 1 implementation begins. It defines the entities, lifecycles, and rules that `packages/core`'s domain modules (see [ADR 0002](../adr/0002-modular-monolith-not-microservices.md)) will implement. Nothing here is code — this is the specification code will be written against.

**Status:** blueprint, not yet implemented. Cross-check against actual code once Phase 1 starts; this document set should be updated if implementation reveals the design needs to change, not silently left to drift.

## Reading order

1. [Business Entities](01-business-entities.md) — the core data model everything else refers to
2. [Booking Lifecycle](02-booking-lifecycle.md)
3. [Driver Lifecycle](03-driver-lifecycle.md)
4. [Customer Lifecycle](04-customer-lifecycle.md)
5. [Pricing Engine](05-pricing-engine.md)
6. [Payments](06-payments.md)
7. [Invoicing](07-invoicing.md)
8. [Dispatch Logic](08-dispatch-logic.md)
9. [Roles & Permissions](09-roles-permissions.md)
10. [Notification Flows](10-notifications.md)
11. [AI Automation Opportunities](11-ai-automation.md)
12. [Database ERD](12-database-erd.md)
13. [API Contracts](13-api-contracts.md)

Engineering conventions (not domain-specific) live in [../engineering/](../engineering/).

## Open questions requiring the founder's confirmation before Phase 1 build-out

These are flagged inline in the relevant documents too, collected here so they aren't missed:

- **Italian e-invoicing (FatturaPA / SDI):** invoices issued by an Italian business are very likely subject to mandatory electronic invoicing requirements. See [Invoicing](07-invoicing.md#compliance-flag-italian-e-invoicing). Needs confirmation with an Italian commercialista before Phase 1 billing work starts.
- **Cancellation/refund policy thresholds** (e.g. free cancellation window, no-show charge) — modeled as configurable, but the actual business numbers need to come from the founder. See [Payments](06-payments.md#cancellation--refund-policy).
- **NCC licensing data** — Italian NCC (Noleggio Con Conducente) operators have specific licensing/logbook requirements per driver and per vehicle. Modeled at a basic level in [Driver Lifecycle](03-driver-lifecycle.md) and [Business Entities](01-business-entities.md); confirm what fields a compliance audit would actually require.
