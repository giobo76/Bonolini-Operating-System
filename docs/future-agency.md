# Future: AI Automation Agency

**Status:** Not built. This document exists so the platform is designed for this business without spending implementation effort on it yet (per the approved Phase 3/4 roadmap).

## What it is

A second business, run by the same founder, offering Claude-powered automation ("AI agents") as a service to external clients. No product surface exists yet — no app, no routes, no schema beyond the generic `tenant_id` foundation already in place.

## Why it's not code yet

Bonolini Transfer is live and urgent; the agency is not. Building agency-specific code now would be speculative work for a business that doesn't have clients or a defined offering yet — effort better spent making Transfer's booking/dispatch software real. See [ADR 0004](adr/0004-tenant-id-multitenancy.md) for the one piece of groundwork that *is* being laid now.

## What already exists for it (because it was cheap to include)

- Every table has a `tenant_id` column and RLS policies keyed off it, so the agency can become tenant #2 without a schema migration touching every table.
- `packages/auth` role model (`admin`, `dispatcher`, `driver`, `client`) is generic, not Transfer-specific — the agency will likely need its own role set, which the `role` enum can be extended to cover when the time comes.
- The modular monolith / domain-module pattern in `packages/core` (see [ADR 0002](adr/0002-modular-monolith-not-microservices.md)) is a pattern the agency's own domain modules (e.g. `agents`, `workflows`, `agency-billing`) can follow, not a Transfer-only convention.

## What it will likely need, when built (Phase 4+)

- A new app, `apps/agency-web` (marketing site + client portal) — not created yet.
- New domain modules under `packages/core` (e.g. `agents`, `client-workflows`) following the same boundary rules as Transfer's modules (exported interface + Inngest events only).
- `packages/ai` — a new shared package wrapping the Claude API / Claude Agent SDK for building and running client-facing agents. Does not exist yet.
- Its own billing model, likely reusing `billing` module patterns but not its schema (agency billing — e.g. subscriptions/usage — differs from Transfer's per-ride billing).
- A real decision on whether agency clients are also `profiles` rows in the same tenant model, or need a distinct concept — deferred until the offering itself is defined.

## Trigger to start Phase 4

Per the roadmap: after Phase 3 (platform generalization) and once Bonolini Transfer's software is stable in production — not on a calendar date.
