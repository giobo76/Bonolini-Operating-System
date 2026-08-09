# 0005 — Defer Turborepo

**Status:** Accepted — 2026-08-06

## Context

See [0001](0001-monorepo-pnpm-workspaces.md). This ADR exists separately to make the trigger condition explicit and easy to find, since "should we add Turborepo" is a question likely to come up again.

## Decision

Do not add Turborepo in Phase 0 or Phase 1. Use plain `pnpm -r --if-present run <script>` from the root `package.json`.

## Revisit when (concrete trigger)

Add Turborepo only once **build/test/typecheck times across the growing package set are actually slow enough to be felt** — e.g. a full `pnpm build` or `pnpm test` taking long enough to disrupt the solo-dev loop. This is expected to become relevant around Phase 3 (platform generalization, more packages), but the trigger is the felt pain, not the phase number.

Do not add it preemptively "because most monorepos use it" — that reasoning was explicitly rejected in favor of keeping tooling minimal until it earns its place.
