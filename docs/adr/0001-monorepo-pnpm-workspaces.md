# 0001 — Monorepo with pnpm workspaces (no Turborepo yet)

**Status:** Accepted — 2026-08-06

## Context

Bonolini OS is built by a solo founder using Claude Code as the primary implementer, with no other engineers today. It needs to host at least two Next.js apps (`transfer-web`, `transfer-admin`) and several shared packages (domain logic, db, auth, ui) from the start, with a second business (the AI Automation Agency) expected to join the platform later.

## Decision

Use a single monorepo managed with **pnpm workspaces**. Do **not** add Turborepo (or Nx) yet — plain `pnpm -r` scripts are enough at this size.

## Why

- A monorepo lets one person (and one AI assistant) reason across the whole system with a single `CLAUDE.md`, one dependency graph, and one CI pipeline. Polyrepo would add coordination overhead with no offsetting benefit for a team of one.
- Turborepo's main value is task caching/parallelization across many packages with real build times. With ~7 packages and 2 apps and no build step yet, that problem doesn't exist — adding it now would be complexity paid for before it's earned.

## Revisit when

Build/typecheck/test times across the growing package set become noticeably slow (a concrete, felt problem), not on a schedule. See [0005](0005-defer-turborepo.md).
