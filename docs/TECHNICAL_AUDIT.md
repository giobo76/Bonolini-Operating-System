# BOS Technical Audit

Full-repository audit performed by direct code review (not automated scanning). Every finding below is grounded in a specific file; no code was changed as part of this audit. Companion document: [docs/ARCHITECTURE.md](ARCHITECTURE.md).

Severity scale: **Critical** (data breach / cross-tenant leak / business-blocking), **High** (real risk before going further live, no workaround), **Medium** (should fix soon, workable for now), **Low** (worth doing, not urgent).

---

## 1. Architecture strengths

- **Tenant scoping is consistent and correct.** Every service function in `clients`, `quotes`, `bookings`, `marketing` takes `tenantId` as an explicit first argument and includes it in every `WHERE` clause — verified in `packages/core/src/{clients,quotes,bookings,marketing}/service.ts`. `tenantId` is always derived from `ctx.session.profile.tenantId` in routers, never accepted from client input. No IDOR path found.
- **tRPC procedure tiers are applied consistently.** `publicProcedure` / `protectedProcedure` / `staffProcedure` / `adminProcedure` (`packages/core/src/trpc.ts`) are used correctly per-procedure across `clientsRouter`, `quotesRouter`, `bookingsRouter`, `marketingRouter` — no procedure that should be gated was found unguarded, aside from the one deliberate, documented exception (`clients.submitLead`).
- **Module boundary rule (ADR 0002) is respected**, with exactly one documented, justified exception (`business-kpis.ts` reads `clients`/`quotes`/`bookings` tables directly, read-only, explicitly commented as a deliberate low-risk trade-off).
- **Zod validation at every boundary** — tRPC inputs, Server Action form parsing — consistent with the documented coding standard.
- **OAuth CSRF protection is implemented correctly**: random `state`, stored in an `httpOnly`/`sameSite=lax` cookie, validated on callback before any token exchange (`apps/transfer-admin/app/api/marketing/oauth/{start,callback}/route.ts`).
- **Refresh-token encryption is implemented correctly**: AES-256-GCM, random 12-byte IV per encryption, auth tag verified on decrypt, key length validated (`packages/core/src/marketing/encryption.ts`).
- **Anti-enumeration on password reset** — `forgot-password` always shows the same success message regardless of whether the account exists.
- **No TODO/FIXME comment debt.** A repo-wide search found zero `TODO`/`FIXME`/`XXX` markers in project source — gaps are documented in module `README.md` files instead of left as inline comment debt. This is a real discipline strength, not just an absence of noise.
- **Money handled as integer cents throughout**, no floating-point currency arithmetic found.
- **`assertOne()` pattern** (`packages/db/src/utils.ts`) cleanly handles `noUncheckedIndexedAccess: true`, a stricter-than-default TS setting the team chose deliberately.

## 2. Technical debt

| Issue | Severity |
|---|---|
| No shared UI component library — every form/table/card is hand-written per page across both apps, despite shadcn/ui being named in the chosen stack | Medium |
| `formatDate()` duplicated verbatim across 5 files; `formatMoney()`-equivalents duplicated with inconsistent signatures across 2+ files (see [§9](#9-code-duplication)) | Medium |
| Migrations are hand-authored SQL, never generated/diffed by `drizzle-kit` against `packages/db/src/schema/*.ts` — schema and migrations can silently drift with no mechanical check | High |
| `packages/core/src/marketing/google-clients.ts` is explicitly unverified against a live Google account per its own header comment — the entire GA4/GTM/Search Console integration is unrun code | High |
| Inngest scheduled functions (`inngest-functions.ts`) don't use `step.run()` — no automatic per-step retry/memoization, see [§14](#14-production-risks) | High |
| CLAUDE.md's phase/status description is stale relative to actual code (documented in ARCHITECTURE.md §15) | Low |
| `bookings` schema is a simplified 3-state skeleton vs. the full state machine in `docs/domain/02-booking-lifecycle.md`, with invoice/payment fields flattened onto `bookings` instead of separate tables — acceptable as a documented interim step, but will need a real migration later | Medium |

## 3. Security issues

| Issue | Severity |
|---|---|
| **No rate limiting anywhere** — not on `clients.submitLead` (public, unauthenticated), not on `/login`, not on the `/api/trpc` HTTP endpoint. `submitLead`'s own source comment flags this. A single actor can flood the `clients` table or hammer login. | High |
| **No CAPTCHA/bot protection on the public lead form** — combined with no rate limiting, `transfer-web`'s `/request-quote` is fully open to automated abuse | High |
| **No security headers configured** in either `next.config.ts` — no CSP, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, or HSTS. No current XSS vector was found (React auto-escapes all rendered content, no `dangerouslySetInnerHTML` in the codebase), but CSP is the standard defense-in-depth layer for exactly the kind of LLM-generated text (`report.content` in `marketing/reports/[id]/page.tsx`) this app renders | Medium |
| **`google_ads` OAuth scope requested but unused** — `oauth/start/route.ts` requests `https://www.googleapis.com/auth/adwords`, which the app never calls anything with (Ads API isn't integrated). Violates least-privilege: the app is asking a customer to grant more access than it uses | Medium |
| **Auto-provisioning trust boundary**: the `on_auth_user_created` Postgres trigger (`0000_init.sql`) inserts a `profiles` row with role `client` for *any* row inserted into `auth.users`, with no application-level approval step. This is safe only if Supabase's project-level public signup is disabled/invite-only — that assumption is not verified anywhere in code or docs and should be confirmed in the Supabase dashboard | Medium |
| **No CSRF token on Server Actions / tRPC mutations** — mitigated in practice by Supabase's auth cookie being `sameSite=lax` (confirmed in `middleware.ts`/`server.ts` usage of `@supabase/ssr` defaults), which blocks cookie attachment on cross-site POSTs, but there's no explicit second layer | Low |
| **Encryption key has no rotation mechanism** — `MARKETING_TOKEN_ENCRYPTION_KEY` is a single static key with no versioning; rotating it would silently break decryption of every stored refresh token with no migration path | Medium |
| **Non-null assertions (`process.env.X!`) on required secrets** in OAuth routes and `middleware.ts` — if unset, these fail at first use with a raw runtime `TypeError`/malformed-URL error rather than a clear startup-time validation error | Low |

## 4. Authentication review

- Flow is sound: Supabase session cookie → `middleware.ts` refresh via `supabase.auth.getUser()` → `getSession()` re-verification server-side → join to `profiles` for tenant/role (`packages/auth/src/session.ts`). This re-verifies against Supabase on every server-side call rather than trusting a decoded JWT client-side, which is the correct pattern.
- **No MFA** — acceptable for a single-founder admin tool today, but worth planning for before adding staff accounts (dispatchers). **Low** at current scale, **Medium** once a second admin/dispatcher account exists.
- **No application-level brute-force protection on `/login`** — relies entirely on whatever Supabase Auth's platform-level rate limiting provides; nothing in this codebase adds its own throttling or lockout. **Medium**.
- **No signup flow exists in the app** — new users are provisioned externally (Supabase dashboard or direct `auth.users` insert), which is consistent with a solo-founder + small staff operation, but means there's no invite-with-role flow yet; every new signup lands as role `client` regardless of intent (see auto-provisioning finding above). **Low**, matches current team size.
- Password reset (`forgot-password` → email → `auth/confirm` → `reset-password`) correctly uses Supabase's OTP token-hash verification and enforces an 8-character minimum with confirmation match. No issues found.

## 5. Authorization review

- `staffProcedure`/`adminProcedure` checks were verified against every procedure in `clientsRouter`, `quotesRouter`, `bookingsRouter`, `marketingRouter` — role checks are present and correct everywhere a mutation or sensitive read exists. **No confirmed authorization bypass.**
- **`transfer-admin/middleware.ts` only checks "authenticated or not," not role.** Any authenticated user (regardless of role) can load the shell of any page; role enforcement happens deeper, at the tRPC layer, with pages catching `FORBIDDEN` and rendering a `PermissionDenied` component. This means page chrome/navigation is visible to roles that shouldn't see it, even though no actual data leaks (verified: `customers/page.tsx` and `marketing/page.tsx` both catch `TRPCError` before rendering data). **Low** — cosmetic/information-architecture issue, not a data leak, but worth tightening once `driver`/`client`-role UI exists so a driver never even sees a "Marketing" nav link.
- **No "own resource" scoping exists** because no driver- or client-facing procedures are built yet (dispatch/drivers/billing/notifications have no code) — not a current gap, but flagged because the domain doc's full roles/permissions matrix (`docs/domain/09-roles-permissions.md`) assumes it and it doesn't exist yet.
- Cross-reference: the domain-level intended enforcement boundary (RLS) is not what's actually enforcing anything today — see [§7](#7-database-review). tRPC is the *only* enforcement layer currently in effect.

## 6. Database review

| Issue | Severity |
|---|---|
| **Row Level Security is not the enforced boundary.** Every migration writes correct RLS policies, but `getDb()` connects via `DATABASE_URL`, which authenticates as the `postgres` role — a role with `BYPASSRLS`. This is documented in a comment in `0004_funnel_attribution.sql`, but nowhere else (not in the domain docs' roles/permissions doc, not in ADR 0003/0004). A reader relying on the domain docs alone would believe RLS is a live second line of defense; it isn't. If a future `staffProcedure`/`adminProcedure` check is ever missed on a new procedure, there is currently **no second layer** to catch it. | **Critical** as a defense-in-depth gap, even though no exploitable bypass was found in the code that exists today |
| **No serverless connection pooling.** `getDb()` opens a direct `postgres.js` connection to `DATABASE_URL` rather than through Supabase's PgBouncer pooler endpoint. On Vercel (or any serverless host), each concurrent lambda instance opens its own connection; Supabase's connection limits are easy to exhaust under real concurrent traffic. | High (pre-launch fix) |
| Migrations are hand-authored and never diffed against the Drizzle schema — see [§2](#2-technical-debt) | High |
| Indexing looks reasonable for current query patterns (`clients` has 5 indexes including `lower(email)`/`lower(full_name)` for case-insensitive search; `findings`/`check_runs`/`quotes`/`bookings` all have tenant-scoped indexes per their migrations), but no composite index exists for the most common admin-dashboard query shape (`findings` filtered by `tenant_id` + `status` + `severity` together) | Low — revisit if the findings table grows large |
| No down-migrations / rollback scripts for any of the 6 migrations | Low |

## 7. Supabase review

- **Two different Postgres access paths exist side by side**: `getSession()` (`packages/auth/src/session.ts`) queries `profiles` through the Supabase JS client (anon key, PostgREST, RLS-enforced), while every domain service in `packages/core` queries through Drizzle + `getDb()` (`DATABASE_URL`, `postgres` role, RLS-bypassed). This inconsistency is the direct cause of the RLS-not-enforced finding above — it's easy to assume, incorrectly, that because *some* queries in the codebase go through an RLS-respecting client, all of them do. **Medium**, worth calling out explicitly in `docs/adr/0003-supabase-postgres-single-db.md` so it isn't rediscovered as a surprise later.
- **`SUPABASE_SERVICE_ROLE_KEY` is declared in `.env.example` but never referenced in code.** Either it's dead configuration, or it signals an intended-but-unbuilt admin capability (e.g., GDPR-mandated user deletion, which requires the service role since deleting an `auth.users` row can't go through the anon key). **Low** today, becomes relevant the moment GDPR delete is built.
- Supabase project-level settings (whether public signup is open, email confirmation requirements, rate limits on auth endpoints) are **outside this repo and were not verifiable from code** — flagged as an operational item to confirm directly in the Supabase dashboard, not a code defect.

## 8. Performance bottlenecks

| Issue | Severity |
|---|---|
| **`marketing.runCheckNow` ("Analyze Now") runs synchronously inside a single `adminProcedure` mutation**, chaining GA4 + GTM + Search Console + website + attribution checks and, for `on_demand`, a Claude API call — all awaited sequentially within one HTTP request/response cycle. On a serverless host with a default function timeout (Vercel Hobby: 10s, Pro: 60s by default), this is a real timeout risk once more than a couple of linked resources are connected. | Medium–High |
| Inngest scheduled functions loop over tenants and resources **sequentially**, with no concurrency — fine at 1 tenant today, but the loop structure doesn't parallelize even independent per-tenant work | Low today, Medium once tenant #2 (the agency) exists |
| No caching layer (`unstable_cache`, `React.cache`, or a Next fetch cache) on repeatedly-read dashboard data (funnel summary, health score, findings list) — every page navigation re-runs the full query set | Low at current traffic |

## 9. Code duplication

- **`formatDate()` is defined identically in 5 separate files**: `apps/transfer-admin/app/marketing/page.tsx`, `marketing/reports/page.tsx`, `marketing/reports/[id]/page.tsx`, `marketing/connections/page.tsx`, `customers/[id]/page.tsx`. All five use `new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })`. **Medium** — trivial to consolidate into `packages/ui`, and every future page will otherwise re-copy it a sixth time.
- **Money formatting is duplicated with inconsistent shapes**: `customers/[id]/page.tsx`'s `formatMoney(cents, currency)` vs. `marketing/page.tsx`'s `formatMoney(impact: FinancialImpact)` — same name, different signature, different purpose, in the same app. **Medium** — the naming collision itself is a minor readability trap for anyone extending either file.
- The CRUD service pattern (`get`/`list`/`create`/`update`, each scoped by `and(eq(table.tenantId, tenantId), eq(table.id, id))`) repeats near-identically across `clients`, `quotes`, `bookings` services. This is **not** flagged as a problem — per the module-boundary design (ADR 0002) these are meant to be independent, and three similar 5-line functions are cheaper to read than a shared generic-repository abstraction would be. Noted here only to distinguish it from the two duplications above, which have no such justification.
- `permission-denied.tsx` is duplicated per section (`customers/`, `marketing/`) with only copy differences — **Low**.

## 10. Unfinished modules

| Module | Status |
|---|---|
| `dispatch` | README only, zero code — no driver-to-booking assignment exists at all |
| `drivers` | README only, zero code — no driver profile/vehicle/availability data model exists |
| `billing` | README only, zero code — **no Stripe integration, no invoice generation, no payment recording beyond the flattened fields already on `bookings`** |
| `notifications` | README only, zero code — no SMS/email confirmation ever sent to a client or driver for any booking event |
| Google Ads (within `marketing`) | OAuth scope requested, UI lists it as a linkable resource type, but `run-check.ts` explicitly skips `google_ads_account` resources — a connected Ads account is silently never checked |

This is the single biggest gap relative to CLAUDE.md's own roadmap: **Phase 1 as originally scoped (bookings/clients/drivers, manual dispatch, Stripe payment, notifications) is not deliverable yet** — the business cannot run an actual transfer end-to-end (assign a driver, collect payment via card, notify the client) using this software today. Everything currently built (`clients`, `quotes`, a payment-status-tracking `bookings` table, and the Marketing Intelligence Engine) is real and solid, but it's adjacent to, not a replacement for, that core flow.

## 11. Dead code

| Item | Notes |
|---|---|
| `getCostPerStageBySource` (`packages/core/src/marketing/business-kpis.ts`) | Fully implemented and exported, but never called from `marketingRouter` or any UI page — its own comment explains it's waiting on real Google Ads spend data. Not harmful, but unmaintained/untested surface area. **Low**. |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` in `.env.example` | Not referenced directly in source — likely consumed implicitly by the `inngest` SDK's own env-var convention, so probably not truly dead, but unverified. **Low**. |

No genuinely dead exported functions, unused imports, or unreachable branches were found beyond the item above — the codebase is otherwise lean.

## 12. TODOs / stubs

- **Zero literal TODO/FIXME/XXX comments** in project source (confirmed via repo-wide search, excluding `node_modules`). Gaps are tracked in module `README.md` files instead — see [§1](#1-architecture-strengths).
- The four unbuilt modules (`dispatch`, `drivers`, `billing`, `notifications`) are, in effect, **stubs at the folder level**: a `README.md` describing intended responsibility, events to emit/consume, and status "not implemented," with no `schema.ts`/`router.ts`/`service.ts`. This is a deliberate, clean form of stubbing (per `docs/engineering/01-folder-conventions.md`'s module shape), not accidental half-finished code.

## 13. Missing tests

| Gap | Severity |
|---|---|
| **Zero test files exist anywhere in the repository** (`*.test.ts`/`*.spec.ts`, excluding `node_modules` — confirmed via glob) | Critical |
| `packages/core/package.json` declares `"test": "vitest run"` and `vitest` as a devDependency, but there is nothing for it to run | High — this is worse than having no test infra at all, because it looks configured |
| CI's test step is `pnpm test -- --passWithNoTests`, which **always exits green with zero coverage** — CI cannot currently catch a single regression in business logic (tenant scoping, health-score math, dedup logic, encryption round-trip, state-transition rules) | High |
| No tests exist for the two areas where a silent bug would be worst: **tenant-isolation queries** (a missing `eq(table.tenantId, tenantId)` would leak data across tenants and nothing would catch it) and **`computeHealthScore`** (a pure function, trivially testable, currently unverified) | Critical |
| No tests for `encryptToken`/`decryptToken` round-trip, or for `run-check.ts`'s finding-dedup logic (`category:dedupeKey` matching) | High |

## 14. Production risks

| Risk | Severity |
|---|---|
| **Nothing in this codebase has been run against real infrastructure.** `docs/validation-runbook.md` exists specifically because the environment that built this had no Node.js runtime or live Google/Supabase accounts to test against. The entire OAuth flow, all three Google API integrations (GA4, GTM, Search Console), and the Claude-based strategist/report synthesis are unverified end-to-end. | Critical |
| **No error monitoring or structured logging anywhere** — no Sentry, no log aggregation, not even consistent `console.error` usage outside the marketing module's alert/email failure paths. A production failure (a failed booking update, a crashed Inngest run, a broken OAuth callback) would be invisible unless a user reports it. | High |
| **CI has no `build` step** — `next build` for either app has never been verified to succeed in CI, only `typecheck`/`lint`/`test` (the latter vacuous per §13). A build-breaking error could merge to `main` undetected. | High |
| **Inngest functions are not retry-safe.** None of `marketingQuickCheck`/`marketingDailyAudit`/`marketingWeeklyReport` use Inngest's `step.run()`. If the function throws partway through (e.g., tenant 2 of 3 fails), Inngest's automatic retry re-runs the *entire* function from the top — including tenants that already succeeded — risking duplicate `check_runs` rows, duplicate critical-alert emails, and duplicate weekly report emails/`reports` rows. At one tenant this is low-impact (idempotency is protected by the finding-dedup logic for findings themselves, but not for `check_runs` rows or sent emails); it needs fixing before a second tenant makes partial-failure-and-retry a normal occurrence. | Medium–High |
| **No serverless-safe DB connection pooling** — see [§6](#6-database-review). | High |
| **GDPR exposure**: Bonolini Transfer is a live business processing real customer PII (name, phone, email, notes) in the EU today, per CLAUDE.md's own assumptions-on-record. No data export or delete endpoint exists yet (`docs/domain/04-customer-lifecycle.md` explicitly defers this to Phase 2). Soft-delete (`clients.deletedAt`) is not the same as erasure — a "deleted" client's PII is still fully present in the database. | Critical for a live EU business, even though this is a known, documented Phase-2 item rather than an oversight |
| **`marketing.runCheckNow` timeout risk** in a serverless deployment — see [§8](#8-performance-bottlenecks). | Medium |
| **Single hardcoded default-tenant lookup by slug** (`getDefaultTenantId()` in `clients/service.ts`) will throw a hard error on every public lead submission if the seeded `bonolini-transfer` tenant row is ever renamed or deleted — a footgun for whoever eventually touches that row directly in the database. | Low |

---

## 15. Roadmap: highest ROI → lowest ROI

Ordered by (risk avoided or business capability unlocked) ÷ (effort to fix). Each item references the section with full detail.

1. **Add a database connection pooler (Supabase's PgBouncer/`pgbouncer` connection string) to `DATABASE_URL`.** One config change, removes a real pre-launch outage risk (connection exhaustion) that will otherwise surface exactly when the business needs the system most. → [§6](#6-database-review), [§14](#14-production-risks)
2. **Wire up basic error monitoring (Sentry or equivalent) and a `pnpm build` step in CI.** Both are small, mechanical additions that convert "we'll find out from a customer complaint" into "we'll find out from an alert." → [§14](#14-production-risks)
3. **Write tests for the highest-blast-radius logic first: tenant-isolation queries, `computeHealthScore`, `encryptToken`/`decryptToken` round-trip, and the check-run dedup logic.** `vitest` is already installed and configured — this is writing tests, not setting up infrastructure. Directly closes the gap where CI currently can't catch a cross-tenant data leak. → [§13](#13-missing-tests)
4. **Run the existing `docs/validation-runbook.md` end-to-end against real Supabase/Google/Anthropic credentials.** No code change — this is the cheapest way to discover whether the unverified OAuth/GA4/GTM/Search Console/Claude integrations actually work before more is built on top of them. → [§14](#14-production-risks)
5. **Add `step.run()` to the three Inngest functions.** Small refactor, directly prevents duplicate check-runs/emails on retry — cheap now, much more annoying to retrofit once a second tenant is live and partial failures become routine instead of theoretical. → [§14](#14-production-risks)
6. **Add rate limiting to `clients.submitLead` and `/login`.** A public, unauthenticated form with no throttling is an easy target the moment `transfer-web` gets real traffic (or gets found by a bot). Moderate effort (middleware or a simple token-bucket in front of the mutation), high payoff. → [§3](#3-security-issues)
7. **Consolidate `formatDate`/`formatMoney` into `packages/ui`.** Low effort, removes a duplication that will otherwise be copy-pasted a sixth and seventh time as more admin pages are built. → [§9](#9-code-duplication)
8. **Document the RLS-bypass reality in `docs/domain/09-roles-permissions.md` and `docs/adr/0003-supabase-postgres-single-db.md`**, not just in a migration-file comment. Pure documentation, but closes the gap where the domain blueprint currently implies a security boundary that isn't actually active — the highest-leverage place for this to be wrong is exactly the doc a future contributor (human or AI) would trust. → [§6](#6-database-review), [§7](#7-supabase-review)
9. **Drop the unused `adwords` OAuth scope** from `oauth/start/route.ts` until Google Ads integration actually exists. One-line change, immediate least-privilege improvement, no functional loss. → [§3](#3-security-issues)
10. **Add basic security headers (CSP, `X-Frame-Options`, `Referrer-Policy`) to both `next.config.ts` files.** Low effort, standard defense-in-depth; not urgent since no active XSS vector was found, but cheap insurance against the next one. → [§3](#3-security-issues)
11. **Build the `billing` module (Stripe) and `notifications` module (Resend/Twilio) next**, ahead of `dispatch`/`drivers` if the immediate goal is "can a customer be charged and confirmed for a booking already in the system." This is the highest-effort item on this list, but it's what actually closes the gap between "software that tracks bookings" and "software that runs the business," which is the platform's stated mission. → [§10](#10-unfinished-modules)
12. **Build GDPR export/delete endpoints.** High business/legal importance but correctly scoped to Phase 2 in the domain docs — sequenced last here only because it's genuinely more effort than items 1–10 and the business risk is chronic (accumulates over time) rather than acute (a specific failure mode), unlike a database outage or an unmonitored crash. Should not be delayed indefinitely given GDPR applies today. → [§14](#14-production-risks)
