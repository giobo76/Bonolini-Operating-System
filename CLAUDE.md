# Bonolini Operating System (BOS)

## Mission

BOS is the shared software platform for two businesses run by a solo founder:

1. **Bonolini Transfer** — a premium chauffeur/NCC company, **already operating** in Italy (EU — GDPR applies). This is the active, urgent priority.
2. **A future AI Automation Agency** — not built yet. The platform is designed so it can be added later without a rewrite; see [docs/future-agency.md](docs/future-agency.md). Do not build agency-specific code unless explicitly asked.

The founder directs Claude Code as the primary implementer — there is no other engineering team today. That constraint shapes every architectural decision here: favor simplicity and low operational overhead over patterns that assume a larger team.

## Process

For any initiative with lasting architectural consequences (new domain module, new app, a stack change), propose a short plan and get explicit approval before creating files or writing code. Routine work (bug fixes, small features within an already-agreed module) doesn't need this ceremony. See [docs/adr/](docs/adr/) for how past decisions were made and why.

## Current phase

**Phase 0 (foundation) — complete.** Repo scaffold, base folder structure, CI skeleton, shared config, an auth foundation (Supabase Auth + tenant/role model), and the initial multi-tenant database schema exist. **No business logic exists yet** — no booking, dispatch, payment, or notification behavior.

**Domain blueprint — complete, precedes Phase 1 implementation.** Before any Phase 1 code is written, the full business domain is documented in [docs/domain/](docs/domain/): entities, booking/driver/customer lifecycles, pricing, payments, invoicing, dispatch logic, roles/permissions, notification flows, AI automation opportunities, the database ERD, and API contracts. Engineering conventions (folder structure, coding standards) are in [docs/engineering/](docs/engineering/). **Phase 1 implementation must follow these documents** — if code needs to diverge from what's documented, update the document first, don't let them drift apart silently. See [docs/domain/README.md](docs/domain/README.md#open-questions-requiring-the-founders-confirmation-before-phase-1-build-out) for open questions (Italian e-invoicing compliance, cancellation policy thresholds, NCC licensing fields) that need the founder's input before certain parts of Phase 1 can be built.

## Repository structure

```
apps/
  transfer-web/     Public booking site + client portal (Next.js) — placeholder only
  transfer-admin/    Internal ops dashboard (Next.js) — auth-gated placeholder only
packages/
  core/              Domain logic (bookings, dispatch, drivers, clients, billing,
                      notifications) — folders + boundary docs only, no logic yet
  db/                Drizzle schema + migrations (tenants, profiles)
  auth/              Supabase Auth helpers (session, tenant, role)
  ui/                Shared Tailwind preset + design tokens
  jobs/              Inngest client (no functions registered yet)
  config/            Shared tsconfig + eslint base
docs/
  adr/               Architecture Decision Records
  future-agency.md   What the AI Automation Agency will need, later
```

## Module boundary rule (packages/core)

Each domain module (`bookings`, `dispatch`, `drivers`, `clients`, `billing`, `notifications`) owns its own schema slice and logic, and is reachable **only** through its exported interface — never by importing another module's internals directly. Cross-module effects go through **Inngest events** (`packages/jobs`), not direct function calls. See [ADR 0002](docs/adr/0002-modular-monolith-not-microservices.md) and each module's `README.md` under `packages/core/src/*/`.

## Multi-tenancy

Every table carries a `tenant_id`, enforced by Postgres Row Level Security, even though only one tenant (`bonolini-transfer`) exists today. See [ADR 0004](docs/adr/0004-tenant-id-multitenancy.md). Never write a query that assumes single-tenancy just because it's currently true.

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere |
| Frontend | Next.js (App Router) |
| API layer | tRPC (not wired up yet — arrives with the first domain module in Phase 1) |
| Styling | Tailwind CSS + shadcn/ui (components not built yet) |
| Database | PostgreSQL via Supabase |
| ORM | Drizzle ORM |
| Auth | Supabase Auth |
| Background jobs | Inngest |
| Payments | Stripe (Phase 1) |
| SMS / Email | Twilio / Resend (Phase 1) |
| Maps / routing | Google Maps Platform (Phase 1) |
| Monorepo tooling | pnpm workspaces only — **no Turborepo** until build times actually hurt (see [ADR 0005](docs/adr/0005-defer-turborepo.md)) |

## Commands

This sandbox that generated the initial scaffold had no Node/pnpm/git installed, so none of this has been run yet. From a machine with Node 20+ and pnpm 9+:

```
pnpm install          # install all workspace dependencies
pnpm dev:web          # run transfer-web (port 3000)
pnpm dev:admin        # run transfer-admin (port 3001)
pnpm typecheck        # tsc --noEmit across all packages/apps
pnpm lint             # eslint across all packages/apps
pnpm test             # vitest across all packages/apps
pnpm db:generate      # regenerate Drizzle migrations from packages/db/src/schema
pnpm db:migrate       # apply migrations
```

Before running: copy `.env.example` to `.env` and fill in a real Supabase project's URL/keys and `DATABASE_URL`.

## Conventions

Full detail in [docs/engineering/](docs/engineering/) (folder conventions, coding standards). Highlights:

- Internal packages are namespaced `@bos/*` and depended on via `workspace:*`.
- No comments explaining *what* code does — only *why*, when non-obvious (see repo-wide style; this is a general engineering preference, not BOS-specific).
- New domain tables live in `packages/db/src/schema/<module>.ts`, one file per `packages/core` module, re-exported from `packages/db/src/schema/index.ts`.

## Roadmap

| Phase | Status | Goal |
|---|---|---|
| 0 — Foundation | Done | Scaffold, CI, shared config, auth foundation, initial schema |
| Domain blueprint | Done | Full business domain documented in [docs/domain/](docs/domain/) before Phase 1 code |
| 1 — Transfer MVP | Next | bookings/clients/drivers modules, booking flow, manual dispatch, Stripe payment, notifications, CSV import of historical spreadsheet data — implemented per [docs/domain/](docs/domain/) |
| 2 — Operational hardening | Planned | Driver PWA, invoicing/reporting, E2E tests, GDPR export/delete endpoints, first AI-assisted communication |
| 3 — Platform generalization | Planned | Clean up tenant primitives; revisit Turborepo only if build times justify it |
| 4 — Agency MVP | Planned | Second tenant, `packages/ai`, agency product — see [docs/future-agency.md](docs/future-agency.md) |

## Assumptions on record

- Bonolini Transfer operates in Italy (EU) — GDPR applies.
- No legacy booking software to migrate from. Current operations are manual: WhatsApp, email, Google Calendar, spreadsheets. Historical data migration (if any) is a one-time manual/CSV import, not a live integration.
