# BOS Validation Runbook

Purpose: a precise, dependency-ordered checklist for validating everything built so far (Authentication → Customer Management → MIE-1 → CMO data model → funnel attribution → MIE-2) against real infrastructure and real Google accounts. Nothing in this repo has been executed by Claude Code — no Node.js exists in the environment that built it. Every step below is something **you** run; this document exists so that testing is systematic instead of ad hoc.

Work through the sections **in order** — each depends on the ones before it (you can't test MIE-2's GA4 checks before MIE-1's connection flow works, which needs the database migrated, which needs Supabase set up).

## 0. Pre-flight: catch static bugs before spending time on live setup

These cost nothing (no external accounts needed) and will catch a whole class of bugs immediately.

```
pnpm install
pnpm typecheck
pnpm lint
```

- [ ] `pnpm install` completes without errors (this alone will surface any remaining phantom-dependency issues — two were already found and fixed this session: `drizzle-orm` was missing from `packages/core`, `@supabase/ssr`/`@supabase/supabase-js` were missing from `apps/transfer-admin`).
- [ ] `pnpm typecheck` passes across all packages/apps. **Specifically watch for errors on every `const [row] = await db.insert(...).returning();` pattern** (used throughout every `service.ts`) — if `noUncheckedIndexedAccess` in `packages/config/tsconfig.base.json` flags these as possibly-undefined, that's a real, mechanical, repo-wide fix (not a logic bug) and should be done as one pass before anything else.
- [ ] `pnpm lint` passes (or only shows things you're fine leaving).

If any of these fail, fix them before moving on — don't try to validate live behavior on top of code that doesn't even compile.

## 1. Environment setup

- [ ] Create a Supabase project. Copy `.env.example` → `.env`, fill in `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`.
- [ ] Apply migrations **in order** via the Supabase SQL Editor (or `pnpm db:migrate` once `DATABASE_URL` is set): `0000_init.sql`, `0001_clients.sql`, `0002_marketing_connections.sql`, `0003_marketing_findings.sql`, `0004_funnel_attribution.sql`, `0005_marketing_reports.sql`.
- [ ] Bootstrap your first admin: create a user in Supabase Auth → Users, then in SQL Editor: `update profiles set role = 'admin' where id = '<user id>';`
- [ ] Generate `MARKETING_TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`).

## 2. Authentication

- [ ] `pnpm dev:admin` → `http://localhost:3001` → log in with the bootstrapped admin.
- [ ] Sign out, confirm redirect to `/login`.
- [ ] Forgot password → reset link email arrives → reset succeeds → lands signed in.
- [ ] Visiting `/` while logged out redirects to `/login`.

## 3. Customer Management

- [ ] Create a customer (both Private and Company types) at `/customers`.
- [ ] Search/filter work; archive/restore work.
- [ ] Open a customer — confirm the page loads with no errors (this page now also renders Quotes/Bookings sections, tested in step 5).

## 4. MIE-1: Google connection

Requires a Google Cloud project with the Google Ads API, GA4 Data/Admin API, Tag Manager API, and Search Console API enabled, and an OAuth client (Internal/Testing publishing status).

- [ ] Set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` in `.env`.
- [ ] `/marketing/connections` → **Connect Google Account** → complete the consent screen → redirected back with a success banner.
- [ ] Confirm the connection shows `active` with the expected granted scopes.
- [ ] Add one linked resource of each type you have available:
  - Google Ads account (ID like `123-456-7890`) — you can add this now even though MIE-2 doesn't call the Ads API yet.
  - GA4 property (`properties/123456789`)
  - GTM container (`GTM-XXXXXXX`)
  - Search Console site (the exact URL as registered in Search Console)
- [ ] Remove a resource, confirm it disappears. Disconnect, confirm status changes and the reconnect flow works again.

**If this step fails:** it blocks everything below — don't proceed to section 6 until a real connection with real linked resources works.

## 5. Funnel attribution (Click → Lead → Quote → Booking)

- [ ] Set `NEXT_PUBLIC_GTM_CONTAINER_ID` to your real GTM container's public ID, restart `transfer-web`.
- [ ] Visit `http://localhost:3000/request-quote?utm_source=google&utm_campaign=test_campaign&gclid=test123`, submit the form.
- [ ] In GTM Preview mode or GA4 DebugView, confirm a `generate_lead` event actually fired on the thank-you page.
- [ ] In `transfer-admin` → Customers, find the new lead, open it, confirm **Acquisition source** shows `test_campaign`.
- [ ] On that customer: add a quote → accept it → confirm a booking from it → record a deposit → mark completed → record an invoice → record a payment. Confirm each state change persists correctly (reload the page after each step).
- [ ] `/marketing` → **Business Performance** section shows this lead/quote/booking under `test_campaign`, with non-zero revenue, and the conversion rates are no longer "not enough data yet."

## 6. MIE-2: detection

- [ ] Set `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `MARKETING_ALERT_EMAIL`, `MARKETING_MONITORED_URLS` (include at least `http://localhost:3000/` and `http://localhost:3000/request-quote`, or your real deployed URLs).
- [ ] `/marketing` → **Analyze Now**. This is the fastest way to see real findings without waiting for a cron cycle or setting up the Inngest dev server.
- [ ] Confirm it completes (check `/marketing`'s check-run summary / no error banner) and that findings appear, correctly split into Technical Issues vs. Strategic Opportunities.
- [ ] For each linked resource type, verify **at least one specific check** produces a sensible result:
  - **GA4**: confirm the `page_view`/`generate_lead` event-count check and the traffic-drop check run without error (they may produce zero findings if nothing is actually wrong — that's fine, the point is confirming no exception).
  - **GTM**: confirm the "unpublished changes" / "no live version" checks run without error against your real container.
  - **Search Console**: confirm the click-drop and URL Inspection indexing checks run without error against your real site.
  - **Website**: deliberately test the negative case — temporarily point `MARKETING_MONITORED_URLS` at a URL that 404s, re-run Analyze Now, confirm a critical finding appears.
- [ ] Confirm the critical finding from the previous step triggers an actual email via Resend.
- [ ] Run Analyze Now a second time immediately after the first — confirm the **same** finding does NOT duplicate (check `last_seen_at` updates instead of a new row appearing). This is the dedup logic in `run-check.ts` — worth specifically verifying since it's easy to get subtly wrong.
- [ ] Mark a finding Acknowledged/Resolved/Dismissed, confirm the status persists and it drops out of the open-findings view appropriately.
- [ ] Check the Health Score changed sensibly after findings were created/resolved (compare the breakdown numbers against the formula in `packages/core/src/marketing/health-score.ts` — they should be explainable, not mysterious).

## 7. Scheduled jobs (optional but recommended)

- [ ] Locally: `npx inngest-cli dev`, confirm `marketing-quick-check`, `marketing-daily-audit`, `marketing-weekly-report` register (visit the Inngest dev UI, usually `http://localhost:8288`).
- [ ] Manually trigger one from the Inngest dev UI rather than waiting for the cron schedule, confirm it behaves identically to the Analyze Now button.
- [ ] Weekly report: trigger `marketing-weekly-report` manually, confirm a row appears in `/marketing/reports` with real narrative content, and (if Resend is configured) that the digest email arrives.

## What NOT to expect to work yet

Don't spend validation time on these — they're documented as not built, not bugs:

- Campaign policy issues, abnormal spend, abnormal CPC, abnormal CPA, enhanced conversions — blocked on the Google Ads API integration (needs a developer token).
- Any automatic fix/write action anywhere — MIE never writes to Google Ads/GTM, by design.
- GTM tag *firing* verification — only configuration state (published/unpublished) is checked, not runtime behavior.
- Profit-per-campaign — no per-booking cost data exists.
- Driver Management, Calendar, Payments, Invoicing, Pricing Engine — not built.

## When something breaks

Given none of this has run before, expect real bugs on first live run — that's normal, not a sign the approach was wrong. Useful places to look:
- `check_runs.error_message` (if a check run failed outright)
- Server logs for the specific check module that failed (each check function's `catch` blocks are narrow, so the stack trace should point at the right file)
- Whether the issue is a Google API shape mismatch (the actual response didn't match what the code assumed) vs. a logic bug in this repo — worth distinguishing since the fix looks very different
