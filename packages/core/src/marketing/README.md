# marketing — Marketing Intelligence Engine (MIE)

BOS's #1 priority as of 2026-08-06. Purpose: continuously protect and improve Bonolini Transfer's advertising profitability by monitoring Google Ads, GA4, GTM, and Search Console, detecting tracking/anomaly/budget-waste problems, and producing senior-strategist-level analysis — **never** executing a financial decision automatically. This README tracks what's actually built, kept honest on purpose.

## Status: MIE-2 — real detection for GA4/GTM/Search Console/website. Google Ads is not integrated.

**IMPORTANT — read before trusting any of this:** the code below was written against documented Google/Anthropic/Resend API shapes with **no ability to run it** — this sandbox has no Node.js, no real Google account connection, and no live API access. Nothing past MIE-1's OAuth flow has been executed even once. Expect real bugs (exact response shapes, quota edge cases, auth edge cases) the first time this actually runs against a live account. Treat this as a strong first draft, not verified-working software.

### Built this pass

- **Google API client layer** (`google-clients.ts`): OAuth2 client from the stored encrypted refresh token; factory functions for the GA4 Data API, Tag Manager API, and Search Console API clients (all via the `googleapis` package). Includes `resolveGtmContainer()`, which looks up a GTM container's internal `accounts/{id}/containers/{id}` path from its public `GTM-XXXXXXX` ID (what `/marketing/connections` actually asks for).
- **Check modules** (`checks/`), one real implementation each:
  - `website-checks.ts` — HTTP status + response time for URLs in `MARKETING_MONITORED_URLS`. No Google API involved.
  - `ga4-checks.ts` — GA4 events dropping to zero (checks `page_view` and `generate_lead` — **not** `purchase`, since no checkout flow exists yet), and session/traffic drops vs. a prior comparable window.
  - `gtm-checks.ts` — unpublished workspace changes, missing live container version. **Cannot verify tags actually fire at runtime** — the API only exposes configuration state, not GTM's own Preview/Debug firing verification. "Broken tags or triggers" is therefore partially covered, not fully.
  - `search-console-checks.ts` — organic click drops, URL Inspection API indexing verdicts.
  - `attribution-checks.ts` — uses only BOS's own data (no Google API): flags when too many leads arrive with a `gclid` but no UTM tagging (likely broken Google Ads auto-tagging).
- **`run-check.ts`**: the orchestrator both the scheduled jobs and the on-demand button call. Runs every check against every linked resource, **deduplicates** against already-open findings (via `evidence.dedupeKey`, updating `last_seen_at` instead of creating a duplicate every 4 hours), recomputes the Health Score snapshot, and sends a critical alert email if anything critical was found.
- **`strategist.ts`**: Claude-powered synthesis (structured tool-use output matching the findings schema) — runs on `daily_audit`/`on_demand` only, not `quick_check` (cost/latency discipline, per the original cadence design). System prompt explicitly forbids recommending automatic budget/campaign/bid/keyword execution.
- **`weekly-report.ts`** + `reports` table (`0005_marketing_reports.sql`) — gathers the week's findings + Health Score readings, asks Claude for a narrative executive report, stores it, emails a digest.
- **`alerts.ts`** — critical-alert and weekly-digest email sending via Resend. A minimal, marketing-specific sender, **not** the general-purpose notifications module in docs/domain/10-notifications.md (still not built).
- **Inngest scheduling** (`inngest-functions.ts` + `apps/transfer-admin/app/api/inngest/route.ts`): `marketing-quick-check` (every 4h), `marketing-daily-audit` (06:00 daily), `marketing-weekly-report` (Monday 07:00). This is the first real Inngest wiring in the whole codebase — `packages/jobs` previously only exported an empty client.
- **"Analyze Now"** (`marketing.runCheckNow` tRPC mutation, button on `/marketing`) — runs the exact same pipeline synchronously, so you can test detection without needing the Inngest dev server running.
- **`/marketing/reports`** — list + detail pages for weekly reports.
- **transfer-web tracking, installed for the first time**: conditional GTM snippet in `app/layout.tsx` (`NEXT_PUBLIC_GTM_CONTAINER_ID`), and a `generate_lead` `dataLayer` push on the request-quote thank-you page. Without this, "conversion tracking" checks would have been checking for tracking that was never wired up.

### Deliberately NOT built this pass

- **Anything Google Ads API-based** — campaign status, policy issues, disapproved ads, abnormal spend/CPC/CPA, enhanced conversions. The Google Ads API needs a **developer token application** (a real external approval process, separate from OAuth setup, that only the founder can start) plus a materially heavier client library and query language (GAQL) than GA4/GTM/Search Console. Sequenced as the next slice rather than written untested alongside everything else. `resourceType: "google_ads_account"` is already a valid linked-resource type from MIE-1; `run-check.ts` explicitly skips it today (see the comment there).
- **Auto-fix execution** — the founder authorized "fix technical issues automatically where safe" this session and last, but no write capability exists: the GTM OAuth scope requested in MIE-1 is read-only (`tagmanager.readonly`), no re-auth flow exists to request `tagmanager.edit.containers`, and no fix-execution logic was written. Reasoning: building write-capability in the same pass as first building read-detection, before any of it has run against a real account, is exactly the kind of compounding risk worth avoiding. This is the natural next slice once detection is proven against live data — not an oversight.
- Consent Mode v2 and enhanced-conversions diagnostics beyond what GA4's own event data happens to surface — genuinely need GTM/Ads-specific consent-signal inspection this pass doesn't attempt.
- Lead-capture spam/rate-limiting on `clients.submitLead` — still a real, flagged gap.
- Google Business Profile, Meta Ads — explicitly future scope, unchanged.

## Hard constraints (do not relax without the founder reopening this decision)

- **No financial action is ever executed automatically** — no budget changes, no campaign create/stop, no bid changes, no keyword changes, no ad publishing. Ever.
- Non-financial technical auto-fixes are *authorized* but **not implemented** — see above.
- Google Ads API's OAuth scope (`adwords`, once requested) is not truly read-only at the OAuth layer — enforcement there will have to be code discipline (never call a mutate endpoint), same as documented for MIE-1.

## Module boundary

Same rule as every other module (ADR 0002): other code imports only from `./index.ts`. `upsertConnection` is exported directly for the OAuth callback route, same documented exception as before. `marketingInngestFunctions` is exported for `apps/transfer-admin/app/api/inngest/route.ts` to register.
