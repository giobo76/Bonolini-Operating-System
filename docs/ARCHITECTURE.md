# BOS Architecture Report

Generated from a full read of the repository. This is a snapshot of what actually exists in code today, as distinct from what [CLAUDE.md](../CLAUDE.md) and the [docs/domain/](domain/) blueprint describe as the plan. See [§15 Inconsistencies](#15-things-that-look-unfinished-or-inconsistent) for where the two have diverged.

## 1. Project structure

```
apps/
  transfer-web/         Public booking site (Next.js, port 3000)
  transfer-admin/        Internal ops dashboard (Next.js, port 3001)
packages/
  core/                  Domain logic + tRPC router (clients, quotes, bookings, marketing — implemented;
                          dispatch, drivers, billing, notifications — README-only stubs)
  db/                    Drizzle schema + hand-authored SQL migrations
  auth/                  Supabase Auth helpers (browser client, server client, session/role)
  ui/                    Shared Tailwind preset + cn() utility
  jobs/                  Inngest client (function definitions live in packages/core, not here)
  config/                Shared tsconfig.base.json + eslint-base.js
docs/
  adr/                   5 accepted Architecture Decision Records
  domain/                13-doc business domain blueprint + README index
  engineering/           Folder conventions + coding standards
  future-agency.md       What Phase 4 (AI Automation Agency) will need
  validation-runbook.md  Manual checklist for validating everything against real infra
.github/workflows/ci.yml Single "verify" job: typecheck, lint, test (no build/deploy yet)
```

Monorepo tooling is pnpm workspaces only (`apps/*`, `packages/*`) — no Turborepo, deliberately deferred per [ADR 0005](adr/0005-defer-turborepo.md).

## 2. Apps

### `apps/transfer-web` — public booking site
- Deps: `@bos/core`, `@bos/ui`, `@trpc/server`, Next 15, React 19, Zod.
- `app/page.tsx` — static home page, "Full online booking is coming soon," links to `/request-quote`.
- `app/request-quote/page.tsx` — reads UTM/gclid query params, renders them as hidden fields in a lead form (fullName, phone required; email, message optional).
- `app/request-quote/actions.ts` — server action `submitLeadAction`, validates via `leadSubmissionSchema`, calls `createServerCaller().clients.submitLead(...)` (in-process tRPC call, no HTTP hop), redirects to `/request-quote/thank-you` or back with an error.
- `app/request-quote/thank-you/page.tsx` — fires `dataLayer.push({ event: "generate_lead" })`, the exact GA4 event the marketing checks module looks for.
- `app/layout.tsx` — conditionally injects the standard GTM snippet if `NEXT_PUBLIC_GTM_CONTAINER_ID` is set.

This app has exactly one real user flow: lead capture. Nothing else described in the domain docs (search/quote/pay/confirm) is built.

### `apps/transfer-admin` — internal ops dashboard
- Deps: `@bos/auth`, `@bos/core`, `@bos/jobs`, `@bos/ui`, `@supabase/ssr`, `@supabase/supabase-js`, `@trpc/server`, `inngest`, Next 15.
- `middleware.ts` — refreshes the Supabase session cookie on every request; redirects unauthenticated users to `/login` except `/forgot-password`, `/reset-password`, `/auth/confirm`; redirects authenticated users away from `/login`. No role checks at the middleware level.
- Auth pages: `login`, `forgot-password`, `reset-password`, `sign-out-button.tsx`, `auth/confirm/route.ts` (verifies Supabase OTP token-hash links for password recovery / future invite flows).
- `app/page.tsx` — dashboard showing signed-in user's email + role, nav to `/customers` (all staff) and `/marketing` (admin only).
- `app/api/trpc/[trpc]/route.ts` — exposes `appRouter` over HTTP (GET/POST) for external callers; the app itself mostly calls the router in-process via `createServerCaller()`.
- `app/api/inngest/route.ts` — serves `marketingInngestFunctions` (GET/POST/PUT) for the Inngest Dev Server / Cloud.
- `app/api/marketing/oauth/start|callback/route.ts` — Google OAuth flow for connecting a tenant's Ads/GA4/GTM/Search Console account.
- `app/customers/*` — full staff CRUD UI over `clients`/`quotes`/`bookings`: list with search/filter/pagination, create, edit, archive/restore, detail page with quote and booking sub-flows (accept/decline quotes, record deposit, mark completed, cancel, record invoice, record payment).
- `app/marketing/*` — Marketing Intelligence Engine dashboard: funnel/conversion/LTV tables, health score + breakdown, findings list ("Technical Issues" / "Strategic Opportunities"), "Analyze Now" button, OAuth connection management, weekly report list/detail.

This app is substantially built out — far beyond the "auth-gated placeholder" CLAUDE.md describes.

## 3. Packages and their responsibilities

| Package | Responsibility | Status |
|---|---|---|
| `@bos/config` | Shared `tsconfig.base.json` (strict, `noUncheckedIndexedAccess: true`) and `eslint-base.js`, consumed by every other package's one-line config files | Complete, stable |
| `@bos/db` | Drizzle schema (source of truth for table shape) + hand-authored SQL migrations + `getDb()` connection helper | Schema for 4 of 8 planned modules exists |
| `@bos/auth` | Supabase Auth wrapper: browser client, server client (cookie-based), `getSession()`/`getCurrentTenant()`/`requireRole()` | Complete for what's implemented |
| `@bos/core` | All domain logic and the single tRPC `appRouter`; each module owns its schema/router/service and is reachable only through its `index.ts` (ADR 0002) | `clients`, `quotes`, `bookings`, `marketing` implemented; `dispatch`, `drivers`, `billing`, `notifications` are README-only |
| `@bos/jobs` | Thin Inngest client (`inngest` instance only) — function *definitions* deliberately live in `packages/core` to avoid a circular dependency | Complete as designed |
| `@bos/ui` | Tailwind preset + `cn()` class-merge utility + shared global CSS variables | Minimal — no shared components yet (shadcn/ui not started) |

## 4. Shared libraries / cross-cutting utilities

- **`assertOne<T>(rows, context)`** (`packages/db/src/utils.ts`) — narrows a Drizzle `.returning()` array to a single row or throws. Exists specifically to work around `noUncheckedIndexedAccess: true` in the shared tsconfig, which makes every array index access possibly-`undefined`.
- **`cn()`** (`packages/ui/src/lib/utils.ts`) — `twMerge(clsx(...))`, the standard Tailwind class-merge helper.
- **`createServerCaller()`** (`packages/core/src/caller.ts`) — builds a tRPC context and returns `appRouter.createCaller(ctx)` for in-process calls from Server Components/Actions, avoiding an HTTP round-trip to the app's own `/api/trpc` route.

## 5. Authentication flow

1. Supabase Auth issues a session, stored as cookies managed via `@supabase/ssr`.
2. `apps/transfer-admin/middleware.ts` calls `supabase.auth.getUser()` on every request to refresh the session cookie and gate unauthenticated access.
3. Server-side, `getSession()` (`packages/auth/src/session.ts`) re-verifies the user via `supabase.auth.getUser()`, then joins to the `profiles` table (`select id, tenant_id, role, full_name where id = user.id`) — this join is what turns a bare Supabase Auth user into a BOS-aware session (`{ user, profile }`). Returns `null` if there's no user or no profile row.
4. `requireRole(...allowed)` throws `"Not authorized"` if there's no session or the profile's role isn't in the allowed list.
5. `createContext()` in `packages/core/src/trpc.ts` wraps `getSession()` into the tRPC context. Procedure tiers: `publicProcedure` (no check), `protectedProcedure` (session required), `staffProcedure` (role in `["admin","dispatcher"]`), `adminProcedure` (role `"admin"`).
6. New users are auto-provisioned into the seeded `bonolini-transfer` tenant with role `client` via a Postgres trigger (`handle_new_user()` on `auth.users` insert, migration `0000_init.sql`) — there is no in-app signup/invite flow yet.
7. Password recovery: `forgot-password` → `resetPasswordForEmail` → email link → `auth/confirm/route.ts` verifies the OTP token hash → `reset-password` page sets a new password.

**Important caveat**: role/tenant authorization is enforced entirely at the tRPC procedure layer using the session's `profile.tenantId`/`profile.role` — not by Postgres RLS. See [§6](#6-database-layer) and [§15](#15-things-that-look-unfinished-or-inconsistent).

## 6. Database layer

- **ORM**: Drizzle, PostgreSQL dialect, schema source of truth at `packages/db/src/schema/index.ts` (re-exports `tenants`, `profiles`, `clients`, `quotes`, `bookings`, `marketing`).
- **Connection**: `getDb()` lazily creates and caches a `drizzle(postgres(DATABASE_URL), { schema })` instance; throws only when actually called, not at import time, so typecheck/build never needs `DATABASE_URL` set.
- **Migrations**: hand-authored SQL under `packages/db/migrations/` (not yet generated by `drizzle-kit` from the schema), applied sequentially:
  1. `0000_init.sql` — `tenants`, `profiles` (+ `role` enum), RLS foundation (`auth_tenant_id()` security-definer function), auto-provisioning trigger.
  2. `0001_clients.sql` — `clients` table, 5 indexes, `auth_role()` function, admin/dispatcher RLS policies.
  3. `0002_marketing_connections.sql` — `marketing_connections`, `marketing_linked_resources`.
  4. `0003_marketing_findings.sql` — `check_runs`, `findings` (21-category enum), `marketing_health_scores`.
  5. `0004_funnel_attribution.sql` — UTM/attribution columns on `clients`; `quotes`, `bookings` tables; public lead-insert policy on `clients`.
  6. `0005_marketing_reports.sql` — `reports` table.
- **Multi-tenancy**: every table carries `tenant_id`, per [ADR 0004](adr/0004-tenant-id-multitenancy.md). Only one tenant (`bonolini-transfer`, seeded in migration 0000) exists today; `getDefaultTenantId()` in the clients service resolves it by slug.
- **RLS status — not the real enforcement boundary today.** Migration `0004_funnel_attribution.sql` documents that `getDb()` connects via Supabase's standard `DATABASE_URL`, which authenticates as the `postgres` role — a role with `BYPASSRLS`. So RLS policies exist and are correctly written, but they are not what actually gates access; the tRPC procedure tiers (`staffProcedure`/`adminProcedure`) are. RLS remains in place as defense-in-depth in case the connection model changes (e.g., moving to PostgREST or a role-scoped connection).
- **Bookings schema is a simplified skeleton**: `bookingStatusEnum` has only 3 values (`confirmed`, `completed`, `cancelled`) versus the full dispatch-aware state machine in [docs/domain/02-booking-lifecycle.md](domain/02-booking-lifecycle.md) (`draft→confirmed→assigned→en_route→arrived→in_progress→completed`). Invoice/payment fields are flattened directly onto `bookings` rather than living in separate `invoices`/`payments` tables as the domain ERD specifies.

## 7. API layer

- **tRPC** (`@trpc/server`), one router: `appRouter` (`packages/core/src/router.ts`) merges `clients`, `quotes`, `bookings`, `marketing` sub-routers. `dispatch`/`drivers`/`billing`/`notifications` will merge in as they're built.
- Exposed two ways:
  - **In-process**: `createServerCaller()` — used by Server Components and Server Actions in both apps, no HTTP hop.
  - **Over HTTP**: `apps/transfer-admin/app/api/trpc/[trpc]/route.ts` via `fetchRequestHandler` — for external callers (future mobile client, webhooks, direct testing).
- Procedure tiers (`packages/core/src/trpc.ts`): `publicProcedure`, `protectedProcedure`, `staffProcedure`, `adminProcedure` (see [§5](#5-authentication-flow)).
- `clients.submitLead` is deliberately `publicProcedure` — unauthenticated lead capture from `transfer-web`. Flagged in-code as having **no rate-limiting or spam protection**.
- Two plain (non-tRPC) HTTP routes exist for protocol reasons: `/api/inngest` (Inngest's serve handler) and the Google OAuth start/callback pair. [docs/domain/13-api-contracts.md](domain/13-api-contracts.md) also calls for a `/api/webhooks/stripe` route, not yet built (no Stripe integration exists yet).
- `docs/domain/13-api-contracts.md` describes the *intended* full procedure surface for every module; only `clients.*`, `quotes.*`, `bookings.*`, `marketing.*` are actually implemented against it today.

## 8. UI architecture

- Next.js App Router in both apps, Tailwind CSS via a shared preset (`@bos/ui/tailwind.preset`) and shared CSS variables (`@bos/ui/styles.css`, imported into each app's `globals.css`).
- No shared component library yet — `packages/ui` exports only `cn()` and the preset; shadcn/ui components are not built (per CLAUDE.md, arrives with Phase 1 UI work). All current UI (forms, tables, cards) is written ad hoc per page in each app.
- Server Components + Server Actions is the dominant pattern: pages fetch via `createServerCaller()`, mutations go through `"use server"` action files (`actions.ts`) that validate input with Zod schemas from `packages/core`, call the router, and redirect.
- A handful of client components exist where interactivity requires it (`login/page.tsx`, `sign-out-button.tsx`, `forgot-password`, `reset-password` — all Supabase Auth calls that must run client-side).
- No design system, no dark-mode toggle wired up (CSS vars for `.dark` exist in `globals.css` but nothing switches the class).

## 9. Background jobs

- **Inngest**, client-only in `packages/jobs` (`inngest = new Inngest({ id: "bonolini-os" })`); function definitions live in `packages/core/src/marketing/inngest-functions.ts` to avoid a circular dependency between `jobs` and `core`.
- Three scheduled functions, all marketing-only, registered via `apps/transfer-admin/app/api/inngest/route.ts`:
  - `marketing-quick-check` — cron `0 */4 * * *`, runs `runCheck(tenantId, "quick_check")` per tenant.
  - `marketing-daily-audit` — cron `0 6 * * *`, `"daily_audit"` (includes Claude-based strategist synthesis).
  - `marketing-weekly-report` — cron `0 7 * * 1`, `runWeeklyReport(tenantId)`.
- No cross-module event-driven jobs exist yet (the `booking.confirmed` → dispatch/notifications flows described in the module READMEs and domain docs are not implemented — those modules have no code).
- Requires the Inngest Dev Server locally or Inngest Cloud in production; not runnable without one.

## 10. Environment variables

Actually referenced in code:

| Variable | Used by |
|---|---|
| `DATABASE_URL` | `packages/db` (drizzle config + client) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `packages/auth` (browser + server clients), `transfer-admin/middleware.ts` |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` | marketing OAuth start/callback routes, `packages/core/src/marketing/google-clients.ts` |
| `MARKETING_TOKEN_ENCRYPTION_KEY` | `packages/core/src/marketing/encryption.ts` (must be base64-encoded 32 raw bytes; throws if unset or wrong length) |
| `ANTHROPIC_API_KEY` | `packages/core/src/marketing/strategist.ts`, `weekly-report.ts` (Claude-powered finding synthesis / report narrative) |
| `RESEND_API_KEY`, `MARKETING_ALERT_EMAIL`, `MARKETING_ALERT_FROM_EMAIL` | `packages/core/src/marketing/alerts.ts` |
| `MARKETING_MONITORED_URLS` | `packages/core/src/marketing/checks/website-checks.ts`, `search-console-checks.ts` (comma-separated, no UI to manage it) |
| `NEXT_PUBLIC_GTM_CONTAINER_ID` | `apps/transfer-web/app/layout.tsx` |
| `NODE_ENV` | OAuth start route (cookie `secure` flag) |

Declared in `.env.example` but not referenced anywhere in source (either unused today or consumed implicitly by an SDK):
- `SUPABASE_SERVICE_ROLE_KEY` — not referenced in any file found.
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — consumed implicitly by the `inngest` SDK, not read directly.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `GOOGLE_MAPS_API_KEY` — commented out, reserved for Phase 1 features (billing, notifications, maps) that have no code yet.

## 11. External services

| Service | Purpose | Integration status |
|---|---|---|
| Supabase (Postgres + Auth) | Database, authentication | Live, foundational |
| Google OAuth / Ads / Analytics (GA4) / Tag Manager / Search Console | Marketing Intelligence Engine data sources | GA4, GTM, Search Console implemented against documented API shapes; **Google Ads explicitly not integrated** (checks skip `google_ads_account` resources; OAuth requests the `adwords` scope but nothing calls the Ads API) |
| Anthropic Claude API (`@anthropic-ai/sdk`, model `claude-sonnet-5`) | Synthesizes marketing findings and weekly report narratives | Implemented, gracefully no-ops without `ANTHROPIC_API_KEY` |
| Resend | Critical-alert and weekly-digest emails (marketing only) | Implemented, no-ops without `RESEND_API_KEY`/`MARKETING_ALERT_EMAIL` |
| Inngest | Scheduled background jobs | Implemented for marketing cron jobs only |
| Stripe | Payments | Not integrated — no code, env vars reserved/commented out |
| Twilio | SMS notifications | Not integrated — no code, env vars reserved/commented out |
| Google Maps Platform | Routing/distance for pricing | Not integrated — no code, env var reserved/commented out |

Note: `packages/core/src/marketing/google-clients.ts` carries a header comment stating it was written against documented Google API shapes without the ability to run it against a live account — "unverified against a live Google account."

## 12. Build system

- pnpm workspaces (`apps/*`, `packages/*`), pnpm 9.15.0, Node ≥20. No Turborepo — root scripts are plain `pnpm -r --if-present run <script>` fan-outs (`build`, `lint`, `typecheck`, `test`), with `dev:web`/`dev:admin`/`db:generate`/`db:migrate` filtered to specific packages.
- Shared TypeScript config (`packages/config/tsconfig.base.json`): `strict: true`, `noUncheckedIndexedAccess: true`, ES2022/ESNext/Bundler resolution. Every package/app's own `tsconfig.json` extends this.
- Shared ESLint config (`packages/config/eslint-base.js`) via `typescript-eslint`; every package's `eslint.config.js` is a one-line re-export.
- CI (`.github/workflows/ci.yml`): single `verify` job — checkout, pnpm/node setup, `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test -- --passWithNoTests`. **No `build` or deploy step yet** — the workflow comments state this needs real Supabase/Vercel secrets, planned for early Phase 1.

## 13. Development workflow

Per CLAUDE.md and the docs:
```
pnpm install
pnpm dev:web       # transfer-web on :3000
pnpm dev:admin     # transfer-admin on :3001
pnpm typecheck
pnpm lint
pnpm test          # vitest, run: pnpm core has a `vitest run` test script
pnpm db:generate   # regenerate Drizzle migrations (not actually used so far — migrations are hand-written)
pnpm db:migrate
```
Requires copying `.env.example` to `.env` and filling in real Supabase project credentials plus `DATABASE_URL`. `docs/validation-runbook.md` is a manual, dependency-ordered checklist (pre-flight → env setup → auth → customer management → MIE Google connection → funnel attribution → MIE detection → scheduled Inngest jobs) written specifically because none of this has been executed end-to-end against real infrastructure yet — the environment that built it had no Node.js/live accounts available. It already documents two previously-found and fixed phantom-dependency bugs (missing `drizzle-orm` in `packages/core`; missing `@supabase/ssr`/`@supabase/supabase-js` in `apps/transfer-admin`) and flags `noUncheckedIndexedAccess` as a recurring source of `db.insert(...).returning()` typecheck errors to watch for.

## 14. Module boundary and domain-blueprint conformance

Per [ADR 0002](adr/0002-modular-monolith-not-microservices.md), each `packages/core` module should be reachable only through its own `index.ts`, with cross-module effects going through Inngest events rather than direct calls. This holds for the implemented modules, with one documented, deliberate exception: `packages/core/src/marketing/business-kpis.ts` reads the `clients`/`quotes`/`bookings` tables directly (read-only) rather than going through their routers/services, justified in-code as low-risk analytical aggregation rather than a cross-module write path.

No cross-module Inngest events are emitted or consumed anywhere yet (e.g. no `booking.confirmed` event exists) — this pattern is documented in the placeholder module READMEs (`dispatch`, `notifications`) as the intended design but has no code to point to.

## 15. Things that look unfinished or inconsistent

- **CLAUDE.md is stale relative to the actual code.** It describes Phase 0 as complete with "no business logic yet" and both apps as placeholders. In reality, `clients`, `quotes`, `bookings`, and a full Marketing Intelligence Engine (connections, findings, health scoring, Claude-based synthesis, scheduled checks, weekly reports, an admin dashboard) are implemented with real tRPC routers, DB tables, RLS policies, and UI. The repo-structure diagram and tech-stack table ("API layer: tRPC (not wired up yet)") both need updating.
- **RLS is written but not enforced.** Every migration includes RLS policies, but the actual `DATABASE_URL` connection uses the `postgres` role, which has `BYPASSRLS`. Authorization is enforced entirely at the tRPC procedure layer. This is documented in migration `0004_funnel_attribution.sql`'s comments, but nothing else in the docs (including the domain blueprint's roles/permissions doc) flags it — a reader of the domain docs alone would assume RLS is the enforcement boundary.
- **`bookings` schema is a simplified skeleton**, not what the domain ERD describes: a 3-value status enum instead of the full dispatch-aware state machine, and invoice/payment fields flattened onto the `bookings` table instead of separate `invoices`/`payments` tables. The `quotes` and `bookings` module READMEs are explicit that this is intentional scaffolding for the funnel-attribution work, not the final Pricing/Billing feature.
- **Marketing Intelligence Engine was built ahead of the documented Phase 1 roadmap.** CLAUDE.md's roadmap table has Phase 1 as "bookings/clients/drivers modules... manual dispatch... Stripe payment... notifications." None of dispatch, drivers, billing, or notifications exist yet, while a large, mostly-unplanned marketing module does. (Per memory of this project, this was a deliberate priority call — "BOS's #1 priority as of 2026-08-06" — but the roadmap doc doesn't reflect it.)
- **Google Ads is not actually integrated** despite the OAuth flow requesting the `adwords` scope and the connections UI listing `google_ads_account` as a resource type. `run-check.ts` explicitly skips that resource type. A user could add a Google Ads linked resource in the UI and it would silently never be checked.
- **No rate limiting or spam protection** on the public `clients.submitLead` procedure — flagged directly in the router's source comment.
- **No dedup on lead submission** — `submitLead` creates a new `clients` row every time regardless of matching email/phone, explicitly flagged as deferred in `service.ts`.
- **`packages/core/src/marketing/google-clients.ts` is unverified against a live Google account** per its own header comment — it was written against documented API shapes in an environment without Node.js or a live Google account to test against.
- **No shared UI component library** — `packages/ui` has no actual components (shadcn/ui not started), so every form/table/card in both apps is written ad hoc, despite CLAUDE.md listing shadcn/ui as part of the chosen stack.
- **CI has no build or deploy step** — intentional per the workflow's own comments, pending real Supabase/Vercel secrets, but worth noting since it means `next build` has never actually been verified in CI.
- **`db:generate`/drizzle-kit appears unused in practice** — all 6 migrations under `packages/db/migrations/` are hand-authored SQL rather than `drizzle-kit`-generated diffs, so the schema files and the migrations could silently drift from each other since nothing mechanically checks they match.
- **Three founder-input-blocking open questions remain unresolved** per [docs/domain/README.md](domain/README.md): Italian e-invoicing (FatturaPA/SDI) compliance, cancellation/refund policy thresholds, and NCC licensing data fields — all needed before the `billing` module (not yet started) can be built to spec.
- **No role checks at the `transfer-admin` middleware level** — only "authenticated or not" is checked there; role-based access (`staffProcedure`/`adminProcedure`) happens deeper, at the tRPC layer and in individual page components (e.g. `customers/permission-denied.tsx`, `marketing/permission-denied.tsx`), not consistently at the routing layer.
