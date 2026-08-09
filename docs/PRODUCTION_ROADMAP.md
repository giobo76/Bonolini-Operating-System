# BOS Production Readiness Roadmap

This document turns the findings in [docs/ARCHITECTURE.md](ARCHITECTURE.md) and [docs/TECHNICAL_AUDIT.md](TECHNICAL_AUDIT.md) into a sequenced, gated plan. It is a planning document only — no application code is changed here.

**Scope discipline**: Milestones 1–3 are about making what's already built (auth, clients, quotes, bookings, the Marketing Intelligence Engine) trustworthy in production. Milestone 4 is the only place new business features are planned — and even there, this document defines scope and acceptance criteria, not implementation. Per [CLAUDE.md](../CLAUDE.md)'s process rule, each Milestone 4 module still needs a short approval step before its first file is created.

**How to read this**: every issue lists why it matters, effort, business impact, affected packages, dependencies, acceptance criteria, and rollback strategy (where reversibility is meaningful — some items, like adding tests, have no rollback concept because they're purely additive). Milestones then roll these up into duration/risk/ROI/order.

---

## Milestone 1 — Production Foundation

Goal: remove the risks that would cause an outage or an invisible failure under real traffic, before anything else ships. Everything here is infrastructure/config work — no schema changes, no new business logic.

### 1.1 Database connection pooling

**Why it matters**: `packages/db/src/client.ts` opens a direct `postgres.js` connection via `DATABASE_URL`. On serverless hosting, each concurrent function instance opens its own connection; Supabase's connection cap is easy to exhaust the first time real concurrent traffic hits the app, causing intermittent, hard-to-diagnose `too many connections` failures. ([TECHNICAL_AUDIT.md §6, §14](TECHNICAL_AUDIT.md#6-database-review))

- **Effort**: Low — swap `DATABASE_URL` to Supabase's pooled (Supavisor/PgBouncer, transaction-mode) connection string; add `{ prepare: false }` to the `postgres()` client options, which transaction-mode pooling requires (prepared statements aren't safe across pooled connections).
- **Business impact**: High — this is the difference between "works in testing" and "falls over under the first real burst of traffic."
- **Affected packages**: `packages/db` (`src/client.ts`, `drizzle.config.ts`), `.env.example`.
- **Dependencies**: Supabase project must have the pooler endpoint available (standard on all Supabase projects, no provisioning needed). No dependency on other roadmap items.
- **Acceptance criteria**:
  - `DATABASE_URL` points at the pooled connection string in all non-local environments.
  - `postgres()` client is constructed with `prepare: false`.
  - A basic load test (e.g., 50 concurrent requests hitting a read + a write procedure) completes with no connection errors.
  - `packages/db` still passes `pnpm typecheck` unchanged (no schema/API surface change).
- **Rollback strategy**: Revert `DATABASE_URL` to the direct connection string — a single environment-variable change, no data migration involved, safe to roll back instantly.

### 1.2 CI build verification

**Why it matters**: CI currently runs `typecheck`, `lint`, and a vacuous `test` step, but never `next build` for either app. A build-breaking error (bad import, invalid `next.config.ts`, a Server/Client component boundary violation) could merge to `main` completely undetected. ([TECHNICAL_AUDIT.md §14](TECHNICAL_AUDIT.md#14-production-risks))

- **Effort**: Low — add a `build` job/step to `.github/workflows/ci.yml`; requires dummy/placeholder values for required env vars (`DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, etc.) since `next build` will fail if `packages/db`'s `getDb()` or similar throws at build time — verify none of the current code paths call `getDb()` at module-evaluation time (per ARCHITECTURE.md, `getDb()` is lazy, so this should be safe, but must be confirmed for both apps).
  <br>*This item is limited to wiring the build step into CI — no application code changes are made to accommodate it. If the verification step above surfaces a build-time env dependency, that becomes a new, separately-scoped finding rather than something fixed under this item.*
- **Business impact**: High — cheap insurance against shipping a broken deploy.
  <br>Cost of doing nothing: a build-breaking change reaches `main` and is only discovered at actual deploy time (or not at all, if deploys are also manual/ad hoc), turning a 2-minute CI failure into a production incident.
- **Affected packages**: `.github/workflows/ci.yml`, `apps/transfer-web`, `apps/transfer-admin` (config only, no code changes expected).
- **Dependencies**: None blocking — can run in parallel with 1.1.
- **Acceptance criteria**:
  - CI fails if `pnpm --filter @bos/transfer-web build` or `pnpm --filter @bos/transfer-admin build` fails.
  - A deliberately broken PR (bad import) is confirmed to fail CI at the build step before this item is marked done.
- **Rollback strategy**: Remove the build step from the workflow file — trivial `git revert`, no runtime impact since this only affects CI, not production.

### 1.3 Error monitoring

**Why it matters**: There is no error tracking anywhere in the codebase. A failed booking update, a crashed Server Action, or a broken OAuth callback currently fails silently from the operator's perspective — the only signal is a customer or the founder noticing something didn't work. ([TECHNICAL_AUDIT.md §14](TECHNICAL_AUDIT.md#14-production-risks))

- **Effort**: Low–Medium — add an error-tracking SDK (e.g., Sentry's Next.js integration) to both apps; wire it into the tRPC error formatter and Inngest function error handlers so failures are captured with tenant/procedure context, not just a generic stack trace.
- **Business impact**: High — without this, every other production issue in this roadmap is harder to detect and diagnose after the fact.
- **Affected packages**: `apps/transfer-web`, `apps/transfer-admin`, `packages/core` (tRPC error formatting in `trpc.ts`, Inngest function wrappers).
- **Dependencies**: Requires choosing and provisioning a monitoring provider (external account/DSN) before implementation starts.
- **Acceptance criteria**:
  - An intentionally-thrown error in a Server Action and in a tRPC procedure both appear in the monitoring dashboard with tenant/user context attached.
  - An Inngest function failure is captured, not just marked `failed` in the `check_runs` row.
  - No PII beyond what's already logged elsewhere is sent to the third-party provider without deliberate review (GDPR-adjacent consideration, ties to Milestone 2).
- **Rollback strategy**: Remove the SDK and its initialization — additive-only change, no data or schema impact, safe to revert at any time.

### 1.4 Logging

**Why it matters**: Beyond error monitoring (which captures exceptions), there's no structured logging of normal operational events — a check run starting/completing, a booking status change, an OAuth connection event. Without this, reconstructing "what happened" after a support question ("why didn't my client get a confirmation") requires reading raw database rows instead of a log trail. ([TECHNICAL_AUDIT.md §14](TECHNICAL_AUDIT.md#14-production-risks))

- **Effort**: Medium — introduce a minimal structured-logging convention (even a thin wrapper around `console.log`/`console.error` with consistent fields: `tenantId`, `event`, `context`) and apply it at the key seams: tRPC mutations that change state, Inngest function start/end, OAuth flow steps.
- **Business impact**: Medium–High — mostly a support/debuggability multiplier rather than a direct outage-prevention item, but compounds in value every week the system runs in production.
- **Affected packages**: `packages/core` (all service/router files where state changes), `apps/transfer-admin` (API routes).
- **Dependencies**: Benefits from being designed after 1.3 (error monitoring) so the two share a context-tagging convention (tenant, procedure, request id) instead of diverging.
- **Acceptance criteria**:
  - Every state-changing tRPC mutation and every Inngest function emits a structured start/end (or start/success/failure) log line.
  - Log lines include `tenantId` consistently, enabling a future "show me everything that happened for tenant X" query.
  - No secrets (tokens, encryption keys) ever appear in a log line — verified by grep across the logging call sites.
- **Rollback strategy**: Additive only — logging calls can be stripped or disabled via a log-level flag with no functional impact on the app.

### 1.5 Inngest retry safety

**Why it matters**: `marketingQuickCheck`, `marketingDailyAudit`, and `marketingWeeklyReport` (`packages/core/src/marketing/inngest-functions.ts`) don't use Inngest's `step.run()`. If the function throws partway through processing multiple tenants, Inngest's automatic retry re-runs the *entire* function from the top — re-processing tenants that already succeeded, risking duplicate `check_runs` rows, duplicate critical-alert emails, and duplicate weekly-report emails. At one tenant the blast radius is small; it compounds the moment a second tenant exists. ([TECHNICAL_AUDIT.md §14](TECHNICAL_AUDIT.md#14-production-risks))

- **Effort**: Medium — wrap each tenant's unit of work in `step.run(stepId, fn)` so Inngest memoizes completed steps and only retries the failed one; requires care around what's safe to make a "step" versus what should stay in the outer function.
- **Business impact**: Medium–High today (single tenant, findings are already dedup-protected but `check_runs`/emails are not); becomes High the moment a second tenant is onboarded.
- **Affected packages**: `packages/core/src/marketing/inngest-functions.ts` only — `packages/jobs` (the thin Inngest client) is unaffected.
- **Dependencies**: None blocking. Independent of 1.1–1.4, but sequenced last in this milestone because it's the most self-contained refactor and benefits from 1.3/1.4 being in place first to observe whether retries are actually happening in practice.
- **Acceptance criteria**:
  - A forced failure on tenant 2 of 3 (in a test with ≥2 seeded tenants) results in tenants 1 and 3 not being reprocessed on retry, only tenant 2.
  - No duplicate `check_runs` row, critical-alert email, or weekly-report email is produced by a retried run that partially succeeded before.
- **Rollback strategy**: Revert to the previous plain-loop function bodies. Caution: mid-flight runs in progress at deploy time could be affected by the function-definition change (Inngest matches retries against the function version) — deploy this change during a low-activity window (outside the `0 */4 * * *`/`0 6 * * *`/`0 7 * * 1` cron windows) to avoid an in-flight run straddling old and new code.

### Milestone 1 summary

- **Estimated duration**: 1–1.5 weeks for one person, working sequentially; most items are independent and could compress to ~4–5 days if parallelized.
- **Risks**: Low overall — every item here is additive or a config change with a clear, cheap rollback. The main risk is *underestimating* 1.5 (Inngest refactor) if the team is unfamiliar with Inngest's step model.
- **Expected ROI**: Very high. This milestone doesn't add capability, but it's what makes every subsequent milestone's failures visible and recoverable instead of silent. It's also the cheapest milestone in the whole roadmap relative to the risk it removes.
- **Recommended implementation order**: 1.1 (pooling) → 1.2 (CI build) → 1.3 (error monitoring) → 1.4 (logging) → 1.5 (Inngest retry safety). Pooling and CI build are pure config with zero interdependency and should land first; monitoring before logging so logging can reuse its context conventions; Inngest safety last since it's the only item touching actual function logic.

---

## Milestone 2 — Security

Goal: close the gaps that matter most given BOS handles real customer PII for a live EU business today. Ordered so the foundational trust-model decision (2.1) happens before the items that depend on its outcome.

### 2.1 Review Service Role / RLS architecture

**Why it matters**: Every migration writes correct Row Level Security policies, but `getDb()` connects via `DATABASE_URL` as the `postgres` role, which has `BYPASSRLS`. RLS is therefore not the enforced boundary — the tRPC procedure layer (`staffProcedure`/`adminProcedure`) is the *only* thing actually gating access today. This is documented in one migration-file comment and nowhere else, including the domain docs that describe roles/permissions as if RLS were live. ([TECHNICAL_AUDIT.md §6, §7](TECHNICAL_AUDIT.md#6-database-review)) This is the single most consequential item in the whole audit: it's the difference between "one enforcement layer" and "two independent enforcement layers," and right now there's only one.

- **Effort**: Medium–High — this is a decision-plus-implementation item, not a pure bug fix. Two real paths exist:
  1. **Harden the single-layer model deliberately**: keep the `postgres`-role connection (simpler, no query-shape constraints), but compensate with the tenant-isolation test suite (Milestone 3.1), explicit logging of every cross-tenant-shaped query at code review time, and documentation that RLS is defense-in-depth-only, not load-bearing.
  2. **Migrate to an RLS-enforced connection**: switch `getDb()` to a role that respects RLS (e.g., using Supabase's `authenticated` role with a session-scoped JWT context via `SET request.jwt.claims`), making RLS the true second layer. Higher effort — every existing query needs to be verified to still work under the tenant's actual RLS policies (including the one documented exception, `business-kpis.ts`'s cross-module reads), and Drizzle's connection-per-request-context model needs re-architecting since `getDb()` is currently a lazy singleton, not a per-request client.
  <br>This roadmap does not pre-select between the two — that decision needs the founder's input given the effort delta, and is called out as a dependency below.
- **Business impact**: Critical as a defense-in-depth gap (no known active exploit today, since every implemented procedure was verified to scope correctly, but there's no safety net if a future procedure ever misses a role/tenant check).
- **Affected packages**: `packages/db` (migrations, possibly `client.ts`'s connection model), `packages/auth`, `docs/adr/0003-supabase-postgres-single-db.md`, `docs/domain/09-roles-permissions.md`.
- **Dependencies**: **Blocks 2.4 (GDPR export/delete)** if option 2 is chosen, since a service-role-scoped delete operation needs the same access-model clarity. Requires a founder decision before implementation starts — this should be a short written proposal (per CLAUDE.md's process rule for architecturally consequential changes), not code-first.
- **Acceptance criteria**:
  - Whichever option is chosen, `docs/adr/0003-supabase-postgres-single-db.md` (or a new ADR) explicitly states what enforces tenant isolation today and why, so this is never rediscovered as a surprise.
  - If option 2 is chosen: every existing tRPC procedure is re-verified against live RLS policies in a staging environment before merging, with the documented `business-kpis.ts` exception either preserved deliberately (with a policy allowing it) or refactored.
- **Rollback strategy**: Option 1 has no rollback need (it's a documentation/process decision, not a code change). Option 2's rollback is reverting the connection string/role — but because switching connection roles changes which queries succeed or silently return zero rows under RLS, this must be validated in staging first; a bad RLS policy could look like "no results" rather than a hard error, which is a dangerous silent-failure mode to roll back from in production. Recommend a staged rollout (staging → production) with the tenant-isolation test suite (Milestone 3.1) as a gate either way.

### 2.2 Rate limiting

**Why it matters**: `clients.submitLead` (public, unauthenticated) and `/login` have no throttling at the application layer. A single actor can flood the `clients` table via the lead form or brute-force login attempts, and nothing in this codebase would slow them down. ([TECHNICAL_AUDIT.md §3](TECHNICAL_AUDIT.md#3-security-issues))

- **Effort**: Medium — requires picking an approach appropriate to the hosting model (e.g., Upstash Redis + `@upstash/ratelimit` for a serverless-friendly token bucket, or Vercel's built-in Edge Middleware rate limiting if hosted there). A single in-memory counter won't work correctly across multiple serverless instances, so this has a real infrastructure dependency, not just a code change.
- **Business impact**: High — directly closes the easiest-to-exploit gap in the audit; the lead form is public by design and reachable by anyone today.
- **Affected packages**: `apps/transfer-web` (`request-quote/actions.ts` or a new middleware), `apps/transfer-admin/middleware.ts` (login), `packages/core/src/clients/router.ts` (`submitLead` procedure, if enforcing at the procedure level instead of the edge).
- **Dependencies**: Requires a hosting/infra decision (which rate-limit backend) before implementation. Independent of 2.1.
- **Acceptance criteria**:
  - A scripted burst of >N requests to `submitLead` from one IP within a defined window is rejected past the threshold, with a clear error surfaced to the form (not a silent failure).
  - Repeated failed `/login` attempts from one source are throttled or temporarily blocked.
  - Legitimate usage (a real customer submitting one lead) is never rate-limited under normal conditions — verified with a reasonable threshold, not an aggressive one that causes false positives.
- **Rollback strategy**: Disable via a feature flag or revert the middleware/procedure wrapper — additive, no data impact, safe to toggle off instantly if it starts blocking legitimate traffic.

### 2.3 Security headers

**Why it matters**: Neither `next.config.ts` sets any security headers — no CSP, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, or HSTS. No active XSS vector exists today (React auto-escapes everything, no `dangerouslySetInnerHTML` in the codebase), but this is the standard defense-in-depth layer, and it matters more than usual here because `marketing/reports/[id]/page.tsx` renders LLM-generated text (Claude's report narrative) — currently safe because it's rendered as a plain text child, but a CSP is cheap insurance against that ever changing. ([TECHNICAL_AUDIT.md §3](TECHNICAL_AUDIT.md#3-security-issues))

- **Effort**: Low — add a `headers()` function to both `next.config.ts` files.
- **Business impact**: Medium — real but not urgent given no active vulnerability was found; still worth doing before a wider audience uses the admin dashboard.
- **Affected packages**: `apps/transfer-web/next.config.ts`, `apps/transfer-admin/next.config.ts`.
- **Dependencies**: None. The one thing to verify: `transfer-web`'s GTM snippet (`app/layout.tsx`) and any future embedded scripts (Google's OAuth consent redirect, Stripe Checkout in Milestone 4) must be allow-listed in the CSP, or the CSP will break them — test against the actual GTM/GA4 script sources before rolling out.
- **Acceptance criteria**:
  - Both apps return CSP, `X-Frame-Options: DENY` (or `SAMEORIGIN` if any future embedding is needed), `Referrer-Policy`, and HSTS headers, verified via browser dev tools or a header-scanning tool.
  - `transfer-web`'s GTM snippet still loads and fires correctly after the CSP is applied (manual verification in a browser, GTM's debug/preview mode).
- **Rollback strategy**: Remove or loosen the `headers()` config — trivial config-only revert if a header turns out to break something (most likely CSP blocking a third-party script).

### 2.4 GDPR export/delete

**Why it matters**: Bonolini Transfer is a live business processing real customer PII (name, phone, email, notes) in the EU today. No data export or delete endpoint exists; `clients.deletedAt` is a soft delete, not erasure — a "deleted" client's PII remains fully present in the database indefinitely. This is a known, documented Phase-2 item in `docs/domain/04-customer-lifecycle.md`, not an oversight, but it's real legal exposure for an operating business, not a someday-nice-to-have. ([TECHNICAL_AUDIT.md §14](TECHNICAL_AUDIT.md#14-production-risks))

- **Effort**: High — needs a genuine data-subject-request flow: an authenticated admin-triggered export (JSON/CSV of everything tied to a client across `clients`, `quotes`, `bookings`, and eventually `notifications`/`invoices` once Milestone 4 exists) and a real delete path (likely a service-role-authenticated hard delete or anonymization, since the current `DATABASE_URL` role can already write anything — the open question from 2.1 is whether that's the right access path for something this sensitive).
- **Business impact**: Critical — legal/compliance risk for a live EU business, independent of how polished the rest of the product is.
- **Affected packages**: `packages/core/src/clients` (extend, or a small new cross-module admin capability — needs a design decision on whether this lives inside `clients` or as its own thin module per ADR 0002), `packages/db` (may need a `consent_records` table per `docs/domain/04-customer-lifecycle.md`'s GDPR consent model, not just a boolean), `apps/transfer-admin` (an admin-facing "Data requests" UI).
- **Dependencies**: Benefits from 2.1 being resolved first (whether a service-role key is the intended access path for a hard delete). Also depends on the founder confirming the consent-record data model, per the open question already logged in `docs/domain/README.md`.
- **Acceptance criteria**:
  - An admin can trigger an export for a given client and receive a complete, human-readable record of everything BOS holds about them.
  - An admin can trigger a delete that actually removes or irreversibly anonymizes PII (not just sets `deletedAt`), scoped correctly to `tenantId` (reuses the same tenant-scoping discipline already present elsewhere).
  - The action is logged (ties to Milestone 1.4) — a delete/export request itself needs an audit trail.
- **Rollback strategy**: Not meaningfully reversible in the usual sense — a genuine erasure request should not have an "undo." The safety strategy here is upstream of rollback: require an explicit confirmation step, and take a final encrypted backup snapshot of the record immediately before deletion, retained only long enough to handle an accidental-request dispute, per whatever retention policy the founder sets. This is different in kind from every other item in this roadmap and should be called out as such when implemented.

### 2.5 OAuth scope cleanup

**Why it matters**: `apps/transfer-admin/app/api/marketing/oauth/start/route.ts` requests the `adwords` scope, but nothing in the codebase calls the Google Ads API (`run-check.ts` explicitly skips `google_ads_account` resources). This asks customers/the founder to grant more access than the app uses — a straightforward least-privilege violation. ([TECHNICAL_AUDIT.md §3](TECHNICAL_AUDIT.md#3-security-issues))

- **Effort**: Low — remove the `adwords` scope from the `SCOPES` array until Google Ads integration is actually built (tracked separately, out of scope for this roadmap per the "no application features" instruction — this item is a *removal*, not new Ads functionality).
- **Business impact**: Low–Medium — no known active harm today (the token is encrypted at rest and unused), but it's an easy, visible fix and a matter of correctness/trust.
- **Affected packages**: `apps/transfer-admin/app/api/marketing/oauth/start/route.ts`, `packages/core/src/marketing/README.md` (update the documented scope list to match).
- **Dependencies**: None. Independent of every other item in this milestone.
- **Acceptance criteria**: The OAuth consent screen no longer requests the Ads scope; existing connected accounts are unaffected (their already-granted scope is a superset of what's newly requested, so no reconnect is forced).
- **Rollback strategy**: Re-add the scope string — one-line revert. Note: if Google Ads integration is built later (Milestone 4+ candidate, not in this roadmap), already-connected tenants will need to re-consent (`prompt: consent` already forces a fresh refresh token on reconnect, so this is a known, already-handled flow, not a new risk).

### Milestone 2 summary

- **Estimated duration**: 2.5–4 weeks. 2.1 is the long pole if option 2 (RLS-enforced connection) is chosen — budget 1.5–2 weeks for it alone including staging verification; 2.2–2.5 are collectively another 1–1.5 weeks; 2.4 (GDPR) is its own multi-day effort that can run partially in parallel with 2.2/2.3/2.5 once the 2.1 decision is made.
- **Risks**: 2.1 is the one item in this entire roadmap with real potential to introduce a regression (a wrong RLS policy silently returning empty results instead of erroring) if option 2 is chosen without careful staging verification — this is the single highest-risk change in the whole plan and should not be rushed. 2.4 (GDPR) carries process risk more than technical risk: getting the deletion confirmation/audit flow wrong is worse than being slow to ship it.
- **Expected ROI**: High, but uneven across items — 2.1's ROI is about closing a systemic gap (no price on avoiding "the one bug we never had"), while 2.2/2.3/2.5 are cheap, concrete wins. 2.4 is compliance-driven ROI (risk avoidance for a live business) rather than efficiency ROI.
- **Recommended implementation order**: 2.1 first (its outcome affects 2.4's design) → 2.5 and 2.3 in parallel (cheap, independent) → 2.2 → 2.4 last (highest effort, benefits from 2.1's resolution and from Milestone 1's logging being in place for its audit trail).

---

## Milestone 3 — Testing

Goal: close the gap where CI currently cannot catch a single regression in business logic. `vitest` is already configured as a dependency in `packages/core` — this milestone is about writing tests, not building test infrastructure from scratch, though a test-database strategy is a real prerequisite (see below).

**Prerequisite for all items in this milestone**: a repeatable test-database strategy (a local Postgres via Docker Compose, or a dedicated Supabase test project/branch) needs to exist before any test that touches `getDb()` can run in CI. This isn't listed as its own numbered item because it's infrastructure shared by 3.1 and 3.2, but it's a real, non-trivial dependency and should be resourced explicitly rather than assumed.

### 3.1 Tenant isolation tests

**Why it matters**: Every service function was manually verified during the audit to scope correctly by `tenantId` — but "manually verified once" is not the same as "mechanically enforced forever." This is the single highest-value test suite in the codebase: a regression here is a cross-tenant data leak, the worst class of bug this platform can have. ([TECHNICAL_AUDIT.md §13](TECHNICAL_AUDIT.md#13-missing-tests))

- **Effort**: Medium — requires the test-database prerequisite above, plus seeding at least two tenants with overlapping data shapes (same client names/emails across tenants, to catch a missing `tenantId` filter that would otherwise coincidentally "work" with distinct test data).
- **Business impact**: High — this is the test suite that protects the platform's core trust guarantee.
- **Affected packages**: `packages/core` (test files alongside `clients/service.ts`, `quotes/service.ts`, `bookings/service.ts`, `marketing/service.ts`), `packages/db` (test fixtures/seed helpers).
- **Dependencies**: Test-database prerequisite (above). Loosely related to 2.1 — if the RLS-enforced-connection option is chosen, these same tests double as the verification suite for that migration.
- **Acceptance criteria**:
  - For every `list`/`get`/`update`/`delete` service function, a test asserts that tenant A can never read or mutate tenant B's rows, using two tenants with intentionally colliding data.
  - A deliberately-introduced bug (removing one `eq(table.tenantId, tenantId)` clause) causes at least one test to fail — this is verified once, then reverted, as proof the suite actually catches the failure mode it's meant to catch.
- **Rollback strategy**: N/A — purely additive test code, no production behavior changes.

### 3.2 Authentication tests

**Why it matters**: `getSession()`, `requireRole()`, and the tRPC procedure tiers (`protectedProcedure`/`staffProcedure`/`adminProcedure`) are the other half of the platform's trust model alongside tenant isolation. None of this is currently tested. ([TECHNICAL_AUDIT.md §13](TECHNICAL_AUDIT.md#13-missing-tests))

- **Effort**: Medium — requires mocking or stubbing Supabase Auth responses (no user, valid user with no profile, valid user with each role) to test `packages/auth/src/session.ts` and `packages/core/src/trpc.ts` in isolation without a live Supabase connection.
- **Business impact**: High — same class of risk as tenant isolation, but for the role/authentication boundary rather than the tenant boundary.
- **Affected packages**: `packages/auth` (`session.ts`), `packages/core` (`trpc.ts`).
- **Dependencies**: None blocking — can proceed independently of the test-database prerequisite since this is about mocking Supabase Auth responses, not querying real data.
- **Acceptance criteria**:
  - `getSession()` returns `null` for no user and for a user with no `profiles` row, and a correctly-shaped session for a valid user.
  - `staffProcedure` rejects a `client`/`driver`-role session and accepts `admin`/`dispatcher`; `adminProcedure` rejects everything but `admin`.
  - `protectedProcedure` rejects an absent session.
- **Rollback strategy**: N/A — additive test code only.

### 3.3 Health Score tests

**Why it matters**: `computeHealthScore()` (`packages/core/src/marketing/health-score.ts`) is a pure function with real business meaning (it drives the admin dashboard's headline metric and feeds the weekly report) and is currently completely unverified. Being a pure function, it's also the cheapest test in this entire roadmap to write. ([TECHNICAL_AUDIT.md §13](TECHNICAL_AUDIT.md#13-missing-tests))

- **Effort**: Low — no database, no mocking, just input findings arrays and expected `{ overall, breakdown, opportunityValue }` outputs.
- **Business impact**: Medium — wrong math here would silently mislead the founder's read on how the marketing account is doing, which is bad but not an outage or a data leak.
- **Affected packages**: `packages/core/src/marketing/health-score.ts`.
- **Dependencies**: None. Can be done first, in isolation, as a quick win to build momentum for the rest of Milestone 3.
- **Acceptance criteria**:
  - Tests cover: no findings (should be 100/100), a single critical finding per component, the `technical_issue` vs. `strategic_opportunity` multiplier difference, and the floor-at-0 behavior for a component overwhelmed with penalties.
  - The documented category→component mapping (`CATEGORY_COMPONENT`) is exercised for at least one category per component.
- **Rollback strategy**: N/A.

### 3.4 Encryption tests

**Why it matters**: `encryptToken`/`decryptToken` (`packages/core/src/marketing/encryption.ts`) protect the Google OAuth refresh token — "enough to read live ad spend and account data" per the code's own comment. A silent bug here (e.g., in the IV/authTag encoding) could either corrupt every stored token or, worse, weaken the encryption without anyone noticing until a real security review happens. ([TECHNICAL_AUDIT.md §13](TECHNICAL_AUDIT.md#13-missing-tests))

- **Effort**: Low — a pure round-trip test (encrypt then decrypt, assert equality) plus negative tests (malformed payload, wrong key, tampered auth tag should throw).
- **Business impact**: Medium–High — low likelihood of a latent bug given the implementation is straightforward AES-256-GCM, but the impact if one exists is high (credential exposure).
- **Affected packages**: `packages/core/src/marketing/encryption.ts`.
- **Dependencies**: None.
- **Acceptance criteria**:
  - Round-trip test passes for representative token strings (including edge cases: empty string, very long string, unicode).
  - A tampered ciphertext or auth tag causes `decryptToken` to throw, not silently return garbage.
  - A missing/wrong-length `MARKETING_TOKEN_ENCRYPTION_KEY` causes `encryptToken`/`decryptToken` to throw a clear error, not a cryptic one.
- **Rollback strategy**: N/A.

### 3.5 Quote calculation tests

**Why it matters — with an important scoping caveat**: as built today, `quotes` has **no calculation logic to test**. `packages/core/src/quotes/service.ts` accepts a manually-entered `amountCents` from staff; the actual pricing engine (base fare + distance + time + surcharges, described in `docs/domain/05-pricing-engine.md`) does not exist yet — it's explicitly future scope, owned by the `bookings`/pricing feature, not yet built. Writing "quote calculation tests" against the current codebase would mean testing the status state-machine (`draft→sent→accepted/declined/expired`, the `respondedAt` timestamp logic in `updateQuoteStatus`), not fare math, because fare math doesn't exist.
- **Effort**: Low for what actually exists today (state-transition tests for `updateQuoteStatus`); the pricing-engine test suite this item's name implies is **blocked** until the pricing engine itself is built — that's a Milestone 4-or-later scoping decision, not a testing gap.
- **Business impact**: Medium for the state-machine tests (catches an incorrect status transition or a missed `respondedAt` timestamp); the real business impact of "quote calculation" testing only materializes once there's calculation to protect.
- **Affected packages**: `packages/core/src/quotes/service.ts` (test file), `packages/core/src/quotes/schema.ts` (state-transition validity).
- **Dependencies**: **This item should be re-scoped once the founder decides whether the pricing engine is being built.** If it's added to Milestone 4 or a future phase, this test item grows substantially at that point and should move with it rather than being treated as done after covering just the status machine.
- **Acceptance criteria** (for what exists today): every valid status transition (`draft→sent`, `sent→accepted`, `sent→declined`, any status→`expired`) sets `respondedAt` correctly per the documented rule (set on `accepted`/`declined` only); tenant scoping is covered here too (redundant with 3.1, acceptable overlap for a small function).
- **Rollback strategy**: N/A.

### Milestone 3 summary

- **Estimated duration**: 1.5–2.5 weeks, most of which is the test-database prerequisite (3–4 days if using Docker Compose with a local Postgres matching the schema) plus 3.1/3.2 (the two DB/auth-dependent suites, ~3–4 days each). 3.3/3.4/3.5 are collectively 2–3 days since they're pure-function tests with no infrastructure dependency.
- **Risks**: Low technical risk (tests don't touch production behavior), but real scheduling risk if the test-database prerequisite is underestimated — it's easy to treat "add tests" as a small task and then discover there's no repeatable way to run them against a real schema.
- **Expected ROI**: Very high for 3.1/3.2 (protects the two things a data-leak or auth-bypass would cost the business the most), high for 3.3/3.4 (cheap and catches real latent-bug risk), and currently capped for 3.5 until its scope is resolved with the founder.
- **Recommended implementation order**: 3.3 and 3.4 first (no infrastructure dependency, fast wins, build momentum) → stand up the test-database prerequisite → 3.1 → 3.2 → 3.5 (state-machine portion only, flagged for re-scoping).

---

## Milestone 4 — Business Features

Goal: close the gap between "software that tracks bookings" and "software that actually runs the transfer business end-to-end" — assign a driver, collect a payment, notify the client. This is the highest-effort milestone and the only one introducing genuinely new domain modules, so it follows CLAUDE.md's process rule: each module below needs a short approval step before implementation starts, not just this roadmap entry.

**Cross-cutting dependency**: all four modules are blocked, per `docs/domain/README.md`'s open questions, on founder input for: Italian e-invoicing (FatturaPA/SDI) compliance requirements (blocks `billing`), cancellation/refund policy thresholds (blocks `billing`), and NCC licensing data fields (blocks `drivers`). These should be resolved before — or explicitly deferred with a documented interim assumption for — the relevant module's implementation begins.

### 4.1 Dispatch

**Why it matters**: `dispatch` is currently a README with no code — there is no way to assign a driver to a confirmed booking. Per `docs/domain/08-dispatch-logic.md`, Phase 1 scope is intentionally manual assignment (matching today's actual WhatsApp/phone workflow), not algorithmic ranking — which keeps this module's Phase 1 scope smaller than it might first appear.
- **Effort**: High — new schema (driver-to-booking assignment), new module (`schema.ts`/`router.ts`/`service.ts`/`events.ts` per the standard module shape), a candidate-driver filtering pass (5 conditions per the domain doc: active status, availability, no overlapping assignment with buffer, capacity, vehicle class match), and UI in `transfer-admin`.
- **Business impact**: High — this is the first of the four modules that turns a confirmed booking into an actual operational assignment.
- **Affected packages**: new `packages/core/src/dispatch/*`, `packages/db/src/schema/dispatch.ts` (new), `apps/transfer-admin` (assignment UI), `packages/jobs` (emits `dispatch.driver_assigned`, listens to `booking.confirmed` — the first real use of the Inngest cross-module event pattern described but not yet exercised anywhere in the codebase).
- **Dependencies**: **Depends on 4.2 (Drivers) existing first** — you can't assign a driver to a booking if there's no driver data model yet. Also depends on Milestone 1 (logging/monitoring) being in place before shipping operationally-critical code, and ideally Milestone 3's tenant-isolation test pattern extended to cover the new module from day one rather than retrofitted later.
- **Acceptance criteria**: An admin/dispatcher can assign an active, available, capacity-matched driver to a confirmed booking; the assignment is tenant-scoped and staff-role-gated per the established pattern; a `booking.confirmed` → dispatch flow is demonstrable end-to-end in staging.
- **Rollback strategy**: New module, additive to `appRouter` — can be kept unregistered/feature-flagged until validated, and the migration can be reverted cleanly since no existing table is altered, only new ones added.

### 4.2 Drivers

**Why it matters**: No driver profile, vehicle, or availability data model exists at all — this is the prerequisite for `dispatch` (4.1), `notifications` (driver-assignment alerts), and eventually a driver-facing PWA (Phase 2, out of scope here).
- **Effort**: Medium–High — schema for driver profiles, vehicles, and availability/status (per `docs/domain/03-driver-lifecycle.md`'s state machine: `pending→active→suspended/inactive/offboarded`, plus a 5-item onboarding checklist), a `driver`-scoped tRPC procedure tier (doesn't exist yet — today only `staff`/`admin` tiers exist), and admin UI for driver management/onboarding.
- **Business impact**: High — blocks dispatch entirely; this is the true first module to build in this milestone.
- **Affected packages**: new `packages/core/src/drivers/*`, `packages/db/src/schema/drivers.ts` (new), `packages/auth` (new `driverProcedure` tier alongside the existing `staffProcedure`/`adminProcedure`), `apps/transfer-admin`.
- **Dependencies**: Needs the founder's NCC licensing field confirmation (open question in `docs/domain/README.md`) before the schema is finalized — building it with placeholder fields risks a disruptive schema change later.
- **Acceptance criteria**: An admin can onboard a driver through the documented checklist states; a driver's `active`/`suspended`/`inactive` status is queryable by the dispatch module; the driver state machine matches `docs/domain/03-driver-lifecycle.md` exactly (per the coding standard's requirement that state tables mirror domain docs).
- **Rollback strategy**: Same as 4.1 — new, additive module; safe to keep unregistered from `appRouter` until validated.

### 4.3 Billing

**Why it matters**: No Stripe integration, no invoice generation, no payment recording beyond the flattened `invoiced_at`/`paid_at`/amount fields already sitting unused-by-any-real-flow on the `bookings` table today. This is the module with the most direct revenue impact — without it, actually collecting payment for a booking has no software support at all.
- **Effort**: High — Stripe Checkout/Elements integration (PCI SAQ-A per `docs/domain/06-payments.md`), a webhook handler (`POST /api/webhooks/stripe`, one of the two documented non-tRPC routes this platform is meant to have), invoice number sequencing (gapless, per-tenant, per `docs/domain/07-invoicing.md`), and — pending the open compliance question — Italian e-invoicing (FatturaPA/SDI) support.
- **Business impact**: Critical — this is the module that actually closes the loop on getting paid; everything else in the roadmap is in service of this working reliably.
- **Affected packages**: new `packages/core/src/billing/*`, `packages/db/src/schema/billing.ts` (new — likely separate `invoices`/`payments` tables replacing the fields currently flattened onto `bookings`, which is a real migration, not just an addition), `apps/transfer-admin` (new webhook route + billing UI), env vars (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — already reserved in `.env.example`).
- **Dependencies**: **Blocked on founder decisions**: Italian e-invoicing/SDI compliance approach, and cancellation/refund policy thresholds (both explicitly flagged as open questions in `docs/domain/README.md`, not yet engineering-invented). Also benefits from Milestone 2's rate-limiting and security-headers work being in place before a payment webhook endpoint goes live, and from Milestone 1's error monitoring being in place given how costly a silent payment-processing failure would be.
- **Acceptance criteria**: A booking can be paid via Stripe Checkout end-to-end in a staging environment using Stripe's test mode; a webhook-driven `payment_intent.succeeded` event correctly updates booking/invoice state; an invoice number sequence has no gaps under concurrent creation (a real test, not just a code review, given the "gapless" requirement).
- **Rollback strategy**: Given this touches payments, rollback planning matters more than most items here: ship behind a feature flag so a broken billing flow can be disabled without a deploy; keep the Stripe webhook idempotent (Stripe recommends and supports idempotency keys) so a rollback-and-retry never double-charges or double-records a payment.

### 4.4 Notifications

**Why it matters**: No SMS/email is ever sent to a client or driver for any booking event today — confirmation, reassignment, cancellation, completion, or payment status all currently rely on the founder manually communicating via WhatsApp/phone, same as before BOS existed. This is the module every other module's "real-world completeness" depends on.
- **Effort**: Medium — Twilio (SMS) and Resend (email, already integrated for the marketing module's alerts, so the account/SDK pattern already exists) integration, a template system, and the event-listener wiring (`booking.confirmed`, `dispatch.driver_assigned`, `billing.invoice_created`, per the module README's documented intent) — this is more integration work than novel design, since `packages/core/src/marketing/alerts.ts` already demonstrates the Resend pattern to extend.
- **Business impact**: High — directly affects customer experience and reduces the founder's manual coordination load, which is the whole point of the platform per CLAUDE.md's mission.
- **Affected packages**: new `packages/core/src/notifications/*`, `packages/db/src/schema/notifications.ts` (new — delivery tracking table per `docs/domain/10-notifications.md`'s `queued→sent→delivered/failed` model), env vars (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — already reserved).
- **Dependencies**: Depends on 4.1 (Dispatch) and 4.3 (Billing) existing to have real events to listen to (`booking.confirmed` exists today in principle since `bookings` is built, but `dispatch.driver_assigned` and `billing.invoice_created` don't exist until those modules ship) — can be built incrementally, wiring up each event as its source module lands, rather than waiting for all three.
- **Acceptance criteria**: A booking confirmation triggers an SMS and/or email to the client within a defined time window in staging; a failed send is retried and eventually marked `failed` with a visible reason, not silently dropped; delivery status is queryable per the `notifications` table.
- **Rollback strategy**: New, additive module — individual event listeners can be disabled independently (e.g., turn off SMS sending while keeping email) without affecting the modules that emit the events they listen to, since Inngest events are fire-and-forget from the emitter's side.

### Milestone 4 summary

- **Estimated duration**: 8–12 weeks total, sequential-heavy given the dependency chain (Drivers → Dispatch → Notifications can partially parallelize with Billing once Drivers lands). This is by far the largest milestone and the estimate has the widest error bars, since two of the four modules (Billing, Drivers) are blocked on founder decisions not yet made.
- **Risks**: Highest of any milestone — real money (Billing), real compliance exposure (Italian e-invoicing), and the first modules where a bug has direct customer-facing consequences (a driver not shown up, a payment not collected, a client not notified). This is also the first milestone that meaningfully exercises the cross-module Inngest event pattern the architecture is designed around but has never actually used — expect to discover integration issues with that pattern here for the first time.
- **Expected ROI**: Highest of any milestone in absolute business terms — this is what makes the platform actually run the business end-to-end, which is BOS's stated mission — but only realizable after Milestones 1–3 make the foundation trustworthy enough to build revenue-critical code on top of. Shipping Billing before Milestone 1/2 are done would mean shipping a payment system with no error monitoring, no rate limiting, and no tests protecting its tenant isolation — a bad trade even under time pressure.
- **Recommended implementation order**: 4.2 (Drivers) → 4.1 (Dispatch) → 4.4 (Notifications, wired incrementally as 4.1/4.3 land) → 4.3 (Billing) — with Billing's *design and compliance-question resolution* starting in parallel much earlier (it can overlap with Milestone 2/3) even though its *implementation* lands last, since it has the longest external dependency chain (founder decisions, Stripe account setup, potentially SDI integration research).

---

## Overall sequencing

```
Milestone 1 (Foundation)   ──▶ Milestone 2 (Security)   ──▶ Milestone 4 (Business Features)
        │                              │                              ▲
        └──────────────▶ Milestone 3 (Testing) ───────────────────────┘
```

Milestones 1 and 3's pure-function tests (3.3, 3.4) can start immediately and in parallel with Milestone 1 — they have no infrastructure dependency. Milestone 3's DB-dependent tests (3.1, 3.2) are best sequenced after Milestone 1.1 (connection pooling) settles the DB access pattern they'll be testing against. Milestone 2.1 (Service Role/RLS review) is the one item worth pulling earliest within Milestone 2 given how much of Milestone 4's trust model depends on its outcome. Milestone 4 should not start in earnest until Milestones 1–3 are substantially complete — not as a rigid gate, but because every Milestone 4 module is revenue- or customer-facing in a way none of the existing code is, and that's exactly the code most worth having monitoring, tested tenant isolation, and a hardened security posture underneath before it ships.
