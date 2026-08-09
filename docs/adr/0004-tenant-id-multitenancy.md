# 0004 — `tenant_id` on every table, from day one

**Status:** Accepted — 2026-08-06

## Context

Only one business (Bonolini Transfer) is real today. The AI Automation Agency is planned but explicitly **not** being built yet (see [docs/future-agency.md](../future-agency.md)).

## Decision

Every table in the schema carries a `tenant_id` column from the very first migration, even though only one tenant (`bonolini-transfer`, seeded in `0000_init.sql`) exists right now. RLS policies key off `tenant_id` for every table that needs isolation.

## Why

This is the specific, cheap mechanism that makes adding the AI Automation Agency later a matter of creating a second tenant row and a new app, instead of a retrofit or rewrite. Retrofitting tenant isolation onto a schema that was built single-tenant is expensive and risky (it touches every table and every query); designing for it from the first migration costs almost nothing extra now.

## Consequence

Application code should never assume "there is only one tenant" even while that's true in practice — always scope queries and RLS policies by `tenant_id`, resolved via the authenticated user's profile (see `auth_tenant_id()` in `packages/db/migrations/0000_init.sql`).
