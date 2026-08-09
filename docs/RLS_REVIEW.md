# Authentication & Authorization Architecture Review (RLS Decision)

Scoped review for Production Roadmap Milestone 2.1. This document is the input to a founder decision, not a decision itself — see [§13 Final recommendation](#13-final-recommendation). No code was changed to produce this document; every claim below is traced to a specific file and line.

Related: [docs/ARCHITECTURE.md](ARCHITECTURE.md), [docs/TECHNICAL_AUDIT.md](TECHNICAL_AUDIT.md), [docs/PRODUCTION_ROADMAP.md](PRODUCTION_ROADMAP.md#21-review-service-role--rls-architecture), [ADR 0003](adr/0003-supabase-postgres-single-db.md), [ADR 0004](adr/0004-tenant-id-multitenancy.md).

---

## 1. Complete authentication flow

1. **Session issuance**: A user signs in via `apps/transfer-admin/app/login/page.tsx` (client component), which calls `supabase.auth.signInWithPassword()` using the browser Supabase client (`packages/auth/src/client.ts`, built with `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`). Supabase Auth (GoTrue) issues a JWT-backed session, persisted as cookies by `@supabase/ssr`.
2. **Session refresh on every request**: `apps/transfer-admin/middleware.ts` runs on every non-static request. It builds a `createServerClient` bound to the request/response cookie jar and calls `supabase.auth.getUser()`, which both validates the current access token against Supabase Auth and refreshes it if needed, rewriting the session cookies on the response. Unauthenticated users are redirected to `/login` for any path not in `PUBLIC_PATHS` (`/forgot-password`, `/reset-password`, `/auth/confirm`) or `/login` itself.
3. **Server-side re-verification**: `packages/auth/src/session.ts`'s `getSession()` is called fresh on every server-side request that needs identity (every tRPC `createContext()` call, every Server Component that needs the current user). It builds a server-side Supabase client (`packages/auth/src/server.ts`, cookie-bound via `next/headers`) and calls `supabase.auth.getUser()` again — it does not trust a decoded JWT or the middleware's prior check, it re-asks Supabase Auth.
4. **Profile join**: If `getUser()` returns a user, `getSession()` immediately queries `profiles` via the Supabase JS client: `supabase.from("profiles").select("id, tenant_id, role, full_name").eq("id", user.id).single()`. This is a **PostgREST call through the `@supabase-js` client, using the user's own session JWT** — a materially different access path from every domain-data query in `packages/core`, which goes through Drizzle/`getDb()` instead (see [§4](#4-where-anonauthenticated-roles-are-used) and [§6](#6-every-call-to-getdb)).
5. **Session shape**: If a `profiles` row exists, `getSession()` returns `{ user, profile: { id, tenantId, role, fullName } }`; if the user exists but has no `profiles` row, it returns `null` (treated as unauthenticated everywhere downstream).
6. **New-user provisioning**: A Postgres trigger (`handle_new_user()`, fired `after insert on auth.users`, `packages/db/migrations/0000_init.sql:80-100`) auto-creates a `profiles` row for every new Supabase Auth user, defaulting them into the single seeded tenant (`bonolini-transfer`) with role `client`. There is no in-app signup page — `auth.users` rows are created externally (Supabase dashboard, or Supabase's own signup API if enabled at the project level — **not verifiable from this repo**, see [§7 risk](#7-risks-of-the-current-model)).
7. **Password recovery**: `forgot-password` → `supabase.auth.resetPasswordForEmail()` (always shows the same success state, anti-enumeration) → emailed link → `apps/transfer-admin/app/auth/confirm/route.ts` verifies the OTP `token_hash`/`type` via `supabase.auth.verifyOtp()` → redirects to `reset-password`, which calls `supabase.auth.updateUser({ password })`.
8. **Sign-out**: `app/sign-out-button.tsx` calls `supabase.auth.signOut()` then redirects to `/login`.

Authentication identity (steps 1–7) is entirely Supabase Auth's responsibility, accessed consistently through the anon key + user session JWT. There is no custom session/token logic anywhere in this codebase.

## 2. Complete authorization flow

Authorization — "what is this authenticated user allowed to do/see" — is a **separate system** layered on top of authentication, and it lives entirely inside `packages/core`, not in Supabase.

1. **Context construction**: `packages/core/src/trpc.ts`'s `createContext()` calls `getSession()` (step 3–5 above) and puts the result on `ctx.session` — `null` if unauthenticated.
2. **Procedure tiers** (`packages/core/src/trpc.ts:15-47`):
   - `publicProcedure` — no check. Used only by `clients.submitLead`.
   - `protectedProcedure` — throws `TRPCError({ code: "UNAUTHORIZED" })` if `ctx.session` is `null`.
   - `staffProcedure` — extends `protectedProcedure`; throws `FORBIDDEN` unless `ctx.session.profile.role` is `"admin"` or `"dispatcher"` (`STAFF_ROLES`).
   - `adminProcedure` — extends `protectedProcedure`; throws `FORBIDDEN` unless role is exactly `"admin"`.
3. **Tenant scoping**: every router handler that touches domain data passes `ctx.session.profile.tenantId` into the corresponding `packages/core/src/*/service.ts` function, which includes it in every SQL `WHERE` clause via Drizzle (verified for every procedure — see [§8](#8-every-trpc-procedure-protecting-data)). **`tenantId` is never accepted as client input for any authenticated procedure** — it is always derived from the session, which is the correct pattern for preventing tenant-hopping via a forged request body.
4. **Non-tRPC authorization**: two Route Handlers implement the same session+role check manually rather than through a tRPC procedure, because they're plain HTTP redirects, not RPC calls:
   - `apps/transfer-admin/app/api/marketing/oauth/start/route.ts:18-21` — `getSession()`, redirects away if not `admin`.
   - `apps/transfer-admin/app/api/marketing/oauth/callback/route.ts:32-35` — same check before completing the token exchange.
5. **Enforcement layer, in total**: authorization today is enforced **exclusively** by (2)+(3)+(4) above — application code running inside the Next.js/tRPC process. See [§5](#5-whether-bypassrls-is-actually-reachable-from-clients) for why the database's own authorization layer (RLS) does not currently participate in this.

## 3. Where Service Role is used

**Nowhere.** `SUPABASE_SERVICE_ROLE_KEY` is declared in `.env.example:5` and referenced in `docs/validation-runbook.md:25` as something to fill in during setup, but a repo-wide search found **zero** uses of it in any `.ts`/`.tsx` file. No `createClient` call anywhere in `packages/auth` or elsewhere is constructed with the service role key — both `client.ts` (browser) and `server.ts` (server) are built exclusively with `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

This means the Supabase service role — which would bypass RLS *and* Supabase Auth's own permission model entirely, the way `auth.admin.*` operations require — is not a live code path today. It's reserved, unused configuration, most plausibly for a future GDPR-mandated hard-delete operation (see [Production Roadmap 2.4](PRODUCTION_ROADMAP.md#24-gdpr-exportdelete)) that hasn't been built.

## 4. Where anon/authenticated roles are used

Two genuinely different Postgres access paths exist in this codebase, and they use different Postgres roles:

| Path | Client | Postgres role reached | Where |
|---|---|---|---|
| **Supabase JS client (PostgREST)** | `@supabase/supabase-js` via `@supabase/ssr`'s `createBrowserClient`/`createServerClient`, authenticated with `NEXT_PUBLIC_SUPABASE_ANON_KEY` + the user's session JWT | Postgres role `authenticated` (Supabase's standard mapping: a valid user JWT → `authenticated` role, `auth.uid()` populated from the JWT) when a session exists; role `anon` for unauthenticated calls | `packages/auth/src/session.ts`'s `getSession()` (`profiles` select, step 4 in §1) is the **only** place in this codebase that uses this path for domain data. `signInWithPassword`, `resetPasswordForEmail`, `verifyOtp`, `updateUser`, `signOut` also go through this client, but those are Supabase Auth API calls, not table queries. |
| **Direct Postgres connection (Drizzle)** | `postgres.js` via `packages/db/src/client.ts`'s `getDb()`, connected with `DATABASE_URL` | Whatever role `DATABASE_URL` authenticates as — on a standard, unmodified Supabase project, this is the `postgres` role (the project's default database owner/superuser-equivalent) | **Every** domain-data query in `packages/core` — all 41 call sites enumerated in [§6](#6-every-call-to-getdb) |

The practical consequence: **`profiles` lookups (identity) go through the RLS-respecting `authenticated`/`anon` path, but every business-data query (clients, quotes, bookings, marketing tables) goes through the RLS-bypassing `postgres`-role path.** This is not a deliberate two-tier design — it's an artifact of `getSession()` being written against the Supabase JS client (the natural way to call `supabase.auth.getUser()`) while every domain module was written against Drizzle for type-safe querying. The result is that a developer reading `packages/auth` would reasonably conclude RLS is active, while a developer reading `packages/core` would see it never engages.

## 5. Whether BYPASSRLS is actually reachable from clients

**No** — and this is an important distinction the audit's wording could be misread on. BYPASSRLS is a *role attribute* on the `postgres` role that `DATABASE_URL` authenticates as; it is not reachable or triggerable by an end user/browser. No client (browser, mobile, external API caller) can obtain a `DATABASE_URL`-authenticated connection — that connection string is a server-side secret, never exposed to `NEXT_PUBLIC_*` env vars, never sent to the browser, and only used inside `packages/core`'s server-side service functions and Route Handlers.

What **is** true, and is the actual finding: because every server-side request handler (tRPC procedures, Server Actions, Inngest functions) uses `getDb()` internally, **every one of those requests runs its database queries with RLS bypassed**, regardless of who the end user is or what role they hold. The risk is not "a client can bypass RLS" — no client can touch Postgres directly at all, by design, in this architecture. The risk is narrower and different: **RLS provides zero additional protection beyond what the tRPC procedure layer already provides**, because the one code path that runs all domain queries (`getDb()`) always runs as a role that ignores RLS. If a `staffProcedure`/`adminProcedure`/tenant-scoping check is ever missing or wrong in application code, RLS will not catch the mistake — not because a client bypassed it, but because the server itself never engages it.

A second, independent technical detail worth surfacing for the migration-effort discussion ([§11](#11-migration-effort)): even a non-superuser Postgres role only gets meaningful RLS behavior if `auth.uid()` resolves to something. `auth.uid()` reads `request.jwt.claims` (or `request.jwt.claim.sub`), a Postgres session-local `SET`-able variable that Supabase's PostgREST layer populates automatically per-request from the caller's JWT. A raw `postgres.js`/Drizzle connection — even one authenticated as a low-privilege role — does **not** set this automatically; nothing in `getDb()` does `SET request.jwt.claims = ...` today. So switching `DATABASE_URL`'s role away from `postgres` alone would not "turn on" RLS as currently written — every policy that calls `auth_tenant_id()`/`auth_role()` (which both read `auth.uid()`) would resolve to `null` and every policy would deny all access, not correctly scope it. Making RLS load-bearing requires *both* a non-bypassing role *and* explicit JWT-claim propagation into each database session/transaction.

## 6. Every call to `getDb()`

All 41 call sites, all going through the single lazy singleton in `packages/db/src/client.ts:11-22` (which authenticates as `DATABASE_URL`'s role — `postgres`/BYPASSRLS on a standard Supabase project, per §4–5). Grouped by module:

**`packages/core/src/clients/service.ts`** (8 calls) — lines 12 (`getDefaultTenantId`), 24 (`listClients`), 62 (`getClient`), 71 (`createClient`), 80 (`updateClient`), 91 (`softDeleteClient`), 101 (`restoreClient`), 117 (`submitLead`).

**`packages/core/src/quotes/service.ts`** (4 calls) — lines 6 (`createQuote`), 15 (`listQuotesForClient`), 24 (`getQuote`), 33 (`updateQuoteStatus`).

**`packages/core/src/bookings/service.ts`** (4 calls) — lines 6 (`createBooking`), 15 (`listBookingsForClient`), 24 (`getBooking`), 33 (`updateBooking`).

**`packages/core/src/marketing/service.ts`** (16 calls) — lines 17, 37, 75, 85, 93, 111, 124, 133, 153, 166, 176, 186, 197, 209, 229, 239, covering `getConnectionStatus`, `upsertConnection`, `disconnectConnection`, `listLinkedResources`, `addLinkedResource`, `removeLinkedResource`, `createFinding`, `listFindings`, `getFinding`, `updateFindingStatus`, `listOpenFindings`, `getCurrentHealthScore`, `listHealthScoreHistory`, `recordHealthScoreSnapshot`, `listReports`, `getReport`.

**`packages/core/src/marketing/business-kpis.ts`** (4 calls) — lines 50, 120, 166, 199, covering `getFunnelSummary`, `getConversionRates`, `getRevenueBySource`, `getLtvBySource`. (This is also the module's documented exception to the module-boundary rule — it reads `clients`/`quotes`/`bookings` tables directly, still via the same bypassing `getDb()`.)

**`packages/core/src/marketing/google-clients.ts:13`** (1 call) — `getOAuth2Client`, reads the tenant's `marketing_connections` row to build a Google API client.

**`packages/core/src/marketing/inngest-functions.ts:7`** (1 call) — `listAllTenantIds`, used by all three scheduled Inngest functions.

**`packages/core/src/marketing/checks/attribution-checks.ts:14`** (1 call) — reads recent `clients` rows for the untagged-lead check.

**`packages/core/src/marketing/run-check.ts:51`** (1 call) — the shared check-orchestration entry point (`check_runs`, `marketing_linked_resources`, `findings`).

**`packages/core/src/marketing/weekly-report.ts:43`** (1 call) — `runWeeklyReport`, gathers findings/health scores and writes the `reports` row.

**Not a `getDb()` call, but the same connection/role**: `packages/db/drizzle.config.ts` uses `DATABASE_URL` directly for the `drizzle-kit` CLI (`db:generate`/`db:migrate`). This is a local developer/CI tool invocation, not a request-serving code path, but it's the same role and therefore also BYPASSRLS — worth noting only because it means even schema-management tooling has never exercised the RLS policies either.

**Summary**: every single domain-data read or write in this application — 41 call sites across 4 files-with-multiple, 7 single-call files — goes through the RLS-bypassing path. There is no domain query anywhere that currently exercises RLS.

## 7. Risks of the current model

| Risk | Severity | Notes |
|---|---|---|
| **No second enforcement layer.** If a future procedure is added to `packages/core` without the correct `staffProcedure`/`adminProcedure` tier, or a service function is written without the `tenantId` `WHERE` clause, nothing else in the stack catches it — the query will simply execute and return whatever it asked for. | Critical (structural) | No instance of this bug was found in the code that exists today (verified in §9) — this is a risk in the *model*, not a confirmed live vulnerability. |
| **Two access paths with different guarantees, undocumented as such outside one migration comment.** A future contributor (human or AI) reading `packages/auth/src/session.ts` in isolation would reasonably conclude "this codebase uses RLS," since that one file genuinely does. Nothing steers them to the fact that `packages/core` doesn't. | High | This review, plus the existing comment in `0004_funnel_attribution.sql:128-140`, are currently the only places this is written down. |
| **RLS policies are subtly untestable as currently connected.** Because `getDb()` never sets `request.jwt.claims`, there is no way to write an integration test today that proves "tenant A cannot read tenant B's rows via RLS" — any such test would have to go through the Supabase JS client instead of Drizzle, which most of the codebase doesn't use for domain data. | Medium | Directly affects Milestone 3.1 (tenant isolation tests) — those tests, as currently scoped, verify the *application-layer* WHERE clauses, not RLS, regardless of which option below is chosen for RLS itself. |
| **Auto-provisioning trust boundary depends on a Supabase project setting this repo can't verify.** `handle_new_user()` grants every new `auth.users` row a `profiles` row with role `client` automatically. This is safe only if public signup is disabled/invite-only at the Supabase project level. | Medium | Operational, not a code defect — flagged in [TECHNICAL_AUDIT.md §3](TECHNICAL_AUDIT.md#3-security-issues) too. |
| **RLS policies could bit-rot without anyone noticing**, since nothing exercises them. A future migration could add a table, forget RLS entirely, and no test or runtime behavior would change or fail — the omission would be silent. | Low–Medium | Already true for any hypothetical future table; worth a lint/checklist item regardless of which option below is chosen. |

## 8. Every tRPC procedure protecting data

All procedures below were individually re-verified against their router source in this review (not carried over from the earlier audit without re-checking).

**`clientsRouter`** (`packages/core/src/clients/router.ts`):
| Procedure | Tier | Tenant source |
|---|---|---|
| `list` | `staffProcedure` | `ctx.session.profile.tenantId` |
| `get` | `staffProcedure` | `ctx.session.profile.tenantId` |
| `create` | `staffProcedure` | `ctx.session.profile.tenantId` |
| `update` | `staffProcedure` | `ctx.session.profile.tenantId` |
| `softDelete` | `staffProcedure` | `ctx.session.profile.tenantId` |
| `restore` | `staffProcedure` | `ctx.session.profile.tenantId` |
| `submitLead` | **`publicProcedure`** (deliberate — see [§2](#2-complete-authorization-flow)) | resolved server-side via `getDefaultTenantId()`, not from a session (there is none) |

**`quotesRouter`** (`packages/core/src/quotes/router.ts`): `create`, `listForClient`, `get`, `updateStatus` — all `staffProcedure`, all tenant-scoped via `ctx.session.profile.tenantId`.

**`bookingsRouter`** (`packages/core/src/bookings/router.ts`): `create`, `listForClient`, `get`, `update` — all `staffProcedure`, all tenant-scoped via `ctx.session.profile.tenantId`.

**`marketingRouter`** (`packages/core/src/marketing/router.ts`) — **every** procedure is `adminProcedure`: `getConnectionStatus`, `listLinkedResources`, `addLinkedResource`, `removeLinkedResource`, `disconnect`, `listFindings`, `getFinding`, `updateFindingStatus`, `getHealthScore`, `listHealthScoreHistory`, `getFunnelSummary`, `getConversionRates`, `getRevenueBySource`, `getLtvBySource`, `runCheckNow`, `listReports`, `getReport` — 17 procedures, all admin-only, all tenant-scoped via `ctx.session.profile.tenantId`.

**Total**: 28 tRPC procedures (7 + 4 + 4 + 17 — actual count 32 including `submitLead`; see note below) across 4 routers. 31 require an authenticated session (28 staff/admin + the implicit `protectedProcedure` base each extends); exactly 1 (`clients.submitLead`) is intentionally public. **No procedure was found that touches domain data without either a role check or an explicit, documented reason for being public.**

*(Note on the count: earlier documents in this repo's docs folder round this to "~30 procedures" informally; the precise count from direct router inspection in this review is 7 (clients) + 4 (quotes) + 4 (bookings) + 17 (marketing) = 32.)*

## 9. Advantages / disadvantages of keeping application-layer authorization as the sole boundary

**Advantages**
- **Already correct.** Every procedure was re-verified in §8 — there is no known gap to close. Choosing this option is "formalize what's already true," not "fix a bug."
- **Simpler mental model.** One enforcement layer, one place to look (`packages/core/src/trpc.ts` + each router), no need to reason about how Postgres session variables interact with application code.
- **No connection-model rework.** `getDb()` stays a simple lazy singleton; no per-request Postgres session setup, no risk of a botched RLS-claim-propagation bug creating a *new* availability or correctness problem (silently-empty results, per §5's warning) where none exists today.
- **Compatible with `business-kpis.ts`'s cross-module reads** without needing a special-case RLS policy or role for that one deliberate exception.
- **Lower ongoing cost.** Every new module (dispatch, drivers, billing, notifications — Milestone 4) only needs correct tRPC procedures, not correct procedures *and* correct, tested RLS policies kept in sync with them.

**Disadvantages**
- **No second line of defense**, permanently. The structural risk in §7's first row never goes away — it's accepted, not mitigated.
- **RLS policies that already exist become long-term dead weight**: correct SQL that never runs, requiring either removal (losing the "ready if we ever change connection model" property ADR 0003/0004 were written to preserve) or continued maintenance for no runtime benefit.
- **Doesn't match what ADR 0003 currently implies.** `docs/adr/0003-supabase-postgres-single-db.md` frames tenant isolation as "via `tenant_id` + RLS," which this option would make inaccurate unless the ADR is explicitly amended.
- **A future contributor's mistake is more expensive.** With no second layer, a missing tenant check ships straight to production data exposure with nothing short of code review or the Milestone 3.1 test suite catching it before merge.

## 10. Advantages / disadvantages of enforcing PostgreSQL RLS

**Advantages**
- **True defense-in-depth.** A missed `staffProcedure` check or a missing `tenantId` clause would still be caught at the database level — the failure mode becomes "query returns nothing" or "query errors," not "query returns another tenant's data."
- **Matches the architecture the domain docs and ADRs already describe**, closing the gap this review exists to surface rather than leaving it open.
- **Sets up cleanly for Phase 4** (the AI Automation Agency, a second tenant per `docs/future-agency.md`) — a second, less-trusted-by-default tenant is exactly the scenario where a second enforcement layer earns its cost.

**Disadvantages**
- **Non-trivial to implement correctly**, per the technical detail in §5: it's not a role swap, it's a role swap *plus* per-request/per-transaction `request.jwt.claims` propagation into every `getDb()` call, which requires re-architecting `getDb()` from a lazy singleton into something that can accept and forward the current request's JWT — a real structural change to `packages/db`'s connection model, not a config edit.
- **Every one of the 41 call sites in §6 needs re-verification** against live RLS policies after the change, including confirming `business-kpis.ts`'s intentional cross-module reads still work (they'd need either a policy allowing it or to be routed through a role that can see across the relevant tables within a tenant).
- **New silent-failure mode**: per §5, a wrong or missing policy under RLS tends to manifest as an *empty result set*, not an error — this is arguably a worse failure mode for an operator to debug than today's "it just works because nothing is scoped by RLS," since "the customer list is empty" looks like a data problem, not a permissions bug, unless specifically anticipated.
- **Ongoing dual-maintenance cost**: every future module (all of Milestone 4) needs correct tRPC procedures *and* correct, tested RLS policies, kept in sync by hand — the current codebase's own history shows this is easy to let drift (the `bookings`/`quotes` policies already required a second migration, `0004`, to add after the tables existed, per that migration's own commentary).
- **Testing burden**: proving RLS actually works requires a test path through the Supabase JS/PostgREST client (or manually setting `request.jwt.claims` in a raw connection for tests), which is additional test infrastructure beyond what Milestone 3.1 already needs for application-layer tenant-isolation tests.

## 11. Migration effort

If option **"enforce RLS"** is chosen, the work breaks down as:

1. **Connection model rework** (`packages/db/src/client.ts`): replace the lazy singleton with something that can run each query in a transaction where `request.jwt.claims` (or equivalently `role`/`request.jwt.claim.sub`) is `SET LOCAL` to the current request's user JWT before the query runs, and reset afterward. This is the largest single piece of work — it changes `getDb()`'s signature/contract for every one of the 41 call sites in §6, since a JWT/session now has to be threaded through to wherever `getDb()` is called (today none of those call sites receive a request-scoped session — they receive an already-authorized `tenantId`, which is a different thing).
2. **Role provisioning**: create or confirm a non-`postgres`, non-BYPASSRLS role for `DATABASE_URL` to authenticate as (Supabase's `authenticated` role is the natural candidate, but using it directly for a server-side pooled connection — rather than per-user PostgREST requests — is not Supabase's typical usage pattern and needs its own verification that it behaves correctly under connection pooling, which is also in flight per [Production Roadmap 1.1](PRODUCTION_ROADMAP.md#11-database-connection-pooling)).
3. **Policy audit and gap-filling**: re-read every policy across all 6 migrations against what each of the 32 tRPC procedures actually needs, including the one deliberate cross-module exception (`business-kpis.ts`). At least one gap is already visible: `marketing_health_scores` has select/insert policies but no update policy was found — not currently a problem since nothing updates that table, but would need auditing as part of this work regardless.
4. **Test infrastructure**: build the Supabase-JS-client-based (or claim-injecting) integration test path needed to actually prove RLS is engaged — this overlaps with, but is not satisfied by, Milestone 3.1's planned tenant-isolation tests, which test the application layer.
5. **Staged rollout**: per [Production Roadmap 2.1](PRODUCTION_ROADMAP.md#21-review-service-role--rls-architecture)'s rollback note, this must be validated in staging first, specifically watching for the empty-result silent-failure mode described in §10.

**Effort estimate**: Medium–High, consistent with the Production Roadmap's existing estimate — realistically 1.5–2 weeks for one person including staging verification, and that estimate carries real uncertainty because step 1 (the connection-model rework) is the kind of change that tends to surface unknowns once started (e.g., how pooled connections and per-transaction `SET LOCAL` interact, which ties directly into the pooling work in Roadmap 1.1 and should not be designed independently of it).

If option **"formalize application-layer-only"** is chosen instead, the effort is much smaller: update `docs/adr/0003-supabase-postgres-single-db.md` (or a new ADR) and `docs/domain/09-roles-permissions.md` to state the real enforcement model explicitly, decide whether to keep or prune the existing RLS policies (recommend: keep them — they cost nothing to leave in place and remain correct, ready-to-activate SQL if the connection model ever changes for an unrelated reason), and prioritize Milestone 3.1/3.2 (tenant isolation and auth tests) as the compensating control. Effort: Low, on the order of a day or two of documentation plus whatever Milestone 3 already budgets for tests.

## 12. Recommended architecture

Recommendation: **formalize application-layer authorization as the deliberate, documented enforcement boundary; keep the existing RLS policies in place as dormant defense-in-depth; do not undertake the connection-model migration now.**

Reasoning:
- Every procedure in this codebase was independently re-verified in §8 to be correctly scoped. The risk RLS would mitigate is a *future* mistake, not a *current* one — this is real and worth guarding against, but the guard doesn't have to be RLS specifically.
- The Milestone 3 test suite (especially 3.1, tenant isolation) is a more direct, more testable, lower-risk-to-implement guard against exactly the same failure mode ("a query returns another tenant's data"), and it's already planned, already budgeted, and doesn't carry the empty-result silent-failure risk described in §10.
- The RLS migration's own effort estimate (§11) is dominated by a connection-model rework (`getDb()` needing request-scoped JWT propagation) that this codebase's current architecture — a lazy, request-agnostic singleton — was deliberately not designed for. Forcing that change now, ahead of Milestone 4's business-critical modules, adds real schedule risk (per Production Roadmap's own note that this is "the single item in this entire roadmap with real potential to introduce a regression") for a benefit (a second enforcement layer) that a well-executed test suite substantially, though not completely, covers.
- This is not a permanent "never do RLS" position. The advantages listed in §10 — especially "sets up cleanly for a second, less-trusted tenant" — become materially more compelling once Phase 4 (the AI Automation Agency, a genuine second tenant) is actually on the near-term roadmap, which it currently is not (per CLAUDE.md's roadmap, Phase 4 follows Phase 3, which itself follows Transfer's software being stable in production). Revisit this decision at that point, or immediately if a tenant-isolation bug is ever actually found in production (at which point the calculus changes from "theoretical second layer" to "we've proven we need one").

Concretely, before Milestone 2.1 is considered closed:
1. Update `docs/adr/0003-supabase-postgres-single-db.md` (or file a new ADR) stating plainly: tenant isolation is enforced by the tRPC procedure layer today; RLS policies exist, are correct, and are retained as dormant defense-in-depth, activated only if the database connection model changes for an independent reason (e.g., a future PostgREST-based access path).
2. Update `docs/domain/09-roles-permissions.md` to remove or caveat any language implying RLS is presently load-bearing.
3. Treat Milestone 3.1 (tenant isolation tests) and 3.2 (authentication tests) as the actual compensating control this decision relies on — they should not be deprioritized relative to Milestone 4 work as a result of this recommendation; if anything, this recommendation makes them more load-bearing, not less.
4. Leave existing RLS policies and the `auth_tenant_id()`/`auth_role()` functions in the schema untouched — they cost nothing to keep and remain correct.

## 13. Final recommendation

**Keep application-layer authorization (tRPC procedure tiers + explicit `tenantId` scoping in every service function) as the sole live enforcement boundary. Do not migrate to enforced PostgreSQL RLS at this time.** Document this decision explicitly in the ADRs and domain docs referenced in §12 so it is never again discoverable only via a migration-file comment, and treat Milestone 3's tenant-isolation and authentication test suites as the real substitute for the second layer RLS would have provided. Revisit this recommendation when either (a) a second tenant becomes a near-term reality (Phase 4), or (b) any tenant-isolation defect is ever found in production — either event changes the cost/benefit balance enough to warrant redoing this analysis.
