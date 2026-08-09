# quotes

**Status:** minimal skeleton, implemented 2026-08-06 as part of the Marketing Intelligence Engine's funnel-attribution work (Click → Lead → Quote → ...). Status + money + client link only.

**Owns:** `quotes` (id, tenant_id, client_id, status, amount_cents, currency, notes, responded_at).

**Exposes:** `quotes.create`, `quotes.listForClient`, `quotes.get`, `quotes.updateStatus` (staff-only — admin + dispatcher).

**Not yet built:** the actual pricing/rate-card computation described in docs/domain/05-pricing-engine.md (this module accepts a manually-entered `amountCents` — no distance/duration/vehicle-class calculation yet). That's the real "Pricing & Quotes" feature, still to come per the roadmap; this table is meant to grow into it, not be replaced by it.

**Emits:** — (no cross-module events yet; `bookings` reads quotes directly via `quoteId`, and `marketing`'s KPI engine reads quotes/clients/bookings read-only for analytics — see packages/core/src/marketing/business-kpis.ts and its documented exception to the strict module-boundary rule).

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this and every other domain module follows.
