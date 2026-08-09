# 0002 — Modular monolith, not microservices

**Status:** Accepted — 2026-08-06

## Context

Bonolini Transfer needs software covering bookings, dispatch, drivers, clients, billing, and notifications. A future AI Automation Agency will eventually share the same platform.

## Decision

Build one backend as a **modular monolith**: domain modules (`bookings`, `dispatch`, `drivers`, `clients`, `billing`, `notifications`) live under `packages/core`, each owning its own schema slice and business logic.

Rules that keep it "modular" rather than a ball of mud:

1. A module is only reachable through its exported interface — no module imports another module's internals directly.
2. Cross-module effects happen asynchronously via **Inngest events** (e.g. `booking.confirmed` → dispatch reacts, `booking.completed` → billing reacts), not direct function calls between modules.
3. Every table carries a `tenant_id` from day one (see [0004](0004-tenant-id-multitenancy.md)).

## Why

Microservices solve a problem this project doesn't have: multiple independent teams needing independently deployable services. For a solo founder, they only add deployment complexity, network failure modes, and cross-service debugging pain. A modular monolith gives the same internal separation of concerns at a fraction of the operational cost, and can be split into real services later *if* a specific module's load or a future team's structure genuinely demands it.

## Revisit when

A specific domain module has scaling or team-ownership needs that the monolith can no longer serve — not preemptively.
