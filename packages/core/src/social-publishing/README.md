# social-publishing — automated weekly Facebook + Instagram post

**Status:** v1.1 — real Meta Graph API integration (Facebook Page feed + Instagram Business content publishing), generation/validation/publishing/idempotency kept as separate concerns, **written but never executed against a live Page or Instagram account** (no `FACEBOOK_PAGE_ID`/`FACEBOOK_PAGE_ACCESS_TOKEN`/`INSTAGRAM_BUSINESS_ACCOUNT_ID`/`INSTAGRAM_POST_IMAGE_URL` configured yet — see below). Expect the first live run to surface real bugs, same honest caveat every other externally-integrated module in this codebase carries (see `marketing/README.md`).

## Purpose

Publishes exactly one English-language post per week (Monday 09:00 Europe/Rome) to both the Bonolini Transfer Facebook Page and Instagram account, grounded only in real BOS data — never an invented fact, statistic, testimonial, review, price, or business-volume figure. One generated text, published as-is to both platforms; on Instagram, always as an image post using a real, founder-provided official brand photo (`INSTAGRAM_POST_IMAGE_URL`) — Instagram has no text-only feed post type. Facebook and Instagram publish independently: a failure or missing configuration on one platform never blocks or is conflated with the other's own outcome (`status` tracks Facebook, `instagramStatus` tracks Instagram, on the same row).

## Owns

The `social_posts` table — one row per tenant per calendar week (`UNIQUE(tenant_id, week_start_date)`, the real idempotency boundary), tracking the generated content and the exact data snapshot it was generated from once, plus **two independent outcome tracks on the same row**: Facebook's `status` (`draft → validated → published`, or `failed`) with `metaPostId`/`metaError`/`publishedAt`, and Instagram's `instagramStatus` (`skipped → validated → published`, or `failed`; `skipped` is the default/rest state, not an error) with `instagramMediaId`/`instagramError`/`instagramPublishedAt`.

## Exposes

`runWeeklySocialPost`, `listSocialPosts`, `getWeekStartDateEuropeRome` (`service.ts`); `getRealPostDataSnapshot`, `hasEnoughDataForPost`, `classifyTransferType` (`content-source.ts`); `validatePost`, `validateInstagramCaptionLength` (`validator.ts`); `socialPublishingRouter` (a minimal admin-only tRPC surface: `listPosts`, `runNow`); `socialPublishingInngestFunctions`. `meta-client.ts`'s `publishTextPost`/`publishInstagramPost` stay internal to the module, called only from `service.ts` — same as before Instagram was added.

## Emits/Listens to

A weekly Inngest cron (`social-weekly-post`, Monday 09:00 Europe/Rome) — see `inngest-functions.ts`.

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rule this module follows. It reads `bookings.pickup`/`bookings.destination` directly (`content-source.ts`) — the same narrow, documented, read-only exception `marketing/business-kpis.ts` already takes for cross-module KPI reporting — but never writes to any table it doesn't own, and never touches `pickupAddress`/`destinationAddress` (full street addresses) at all.

## Four separate concerns, deliberately kept apart

Per the founder's explicit instruction:

1. **Generation** (`content-generator.ts`) — one Claude call, given only an aggregated, anonymized data snapshot, writing one platform-neutral post reused for both Facebook and Instagram. Returns `null` (never a placeholder string) if `ANTHROPIC_API_KEY` is unset or Claude returns no text.
2. **Validation** (`validator.ts`) — pure, network-free functions checking length, presence of a call-to-action, absence of forbidden content categories (emails, phone-like numbers, currency amounts, placeholder markers, invented testimonial/rating/business-volume claims), and a light English-language heuristic — all shared by both platforms — plus `validateInstagramCaptionLength`, the one Instagram-specific check (Instagram's 2200-character caption limit is narrower than Facebook's 3000).
3. **Publishing** (`meta-client.ts`) — `publishTextPost` (Facebook) and `publishInstagramPost` (Instagram's two-step media-container-then-publish flow), each calling only the Graph API. Neither reads a data snapshot nor validates; each only ever sends the exact text/image it's given.
4. **Idempotency** (`service.ts`'s `ensureWeeklyPostRow`) — a DB-level `UNIQUE(tenant_id, week_start_date)` constraint plus `INSERT ... ON CONFLICT DO NOTHING`, checked before generation is even attempted. One row covers both platforms for the week.

Logging goes through the existing `packages/core/src/observability.ts` (`log`/`captureException`) — no new logging mechanism was introduced. Its `redact()` already strips any context key matching `/token|secret|password|apikey|api_key|credential/i` before it reaches a log line, which is the backstop behind the harder rule below.

## What real data this module uses, and what it deliberately never uses

No `drivers`/vehicle module exists yet (see `packages/core/src/drivers/README.md` — not built), and no reviews/testimonial system exists anywhere in BOS. Given that, `content-source.ts` reads only:

- **Served routes**: distinct `(pickup, destination)` pairs from `bookings` with status `confirmed` or `completed` in the last 90 days — always the generalized place/city-level fields (e.g. "Milano", "Tirano"), never the full-address columns.
- **Transfer type**: a deterministic keyword match of each route against a small list of Italian airport names/codes, labeling it `"airport transfer"` or `"regional transfer"` — a transform of real text, not an invented category (no service-type column exists to read instead).
- **Service area places**: the deduplicated set of every place name seen across those routes.

**Deliberately never used or exposed to Claude**: client names, phone numbers, emails, individual prices, aggregate revenue, or booking-count/business-volume figures — per the founder's explicit instruction, these are withheld even though `bookings`/`clients` technically hold some of them. A week with zero real, recognizable routes produces `hasEnoughDataForPost() === false`, and the post is skipped entirely (row marked `failed` with an honest reason) rather than padded out with something not actually true that week.

"Useful information for tourists" (one of the content angles the founder asked to prefer) was **not** implemented this pass: no CMS/static-content module exists in BOS to source real, non-invented material from (`transfer-web`'s homepage is still a "coming soon" placeholder — see `apps/transfer-web/app/page.tsx`). Flagged as a gap rather than filled with invented copy.

## Idempotency (max one post per tenant per week)

Two layers:

1. **DB**: `UNIQUE(tenant_id, week_start_date)` on `social_posts` (migration `0016_social_publishing.sql`; Instagram's own columns were added additively in `0018_social_publishing_instagram.sql`, same constraint).
2. **Application**: `ensureWeeklyPostRow` does `INSERT ... ON CONFLICT (tenant_id, week_start_date) DO NOTHING` *before* any data is read or any Claude/Graph API call is made. A retry within the same week either finds no row to insert (conflict) and, if that existing row is already `validated`/`published`/`failed`, is a pure no-op — or, if it inserted the row itself, proceeds exactly once.

`week_start_date` is the Monday of the ISO week containing the cron's own trigger instant, computed in Europe/Rome (`getWeekStartDateEuropeRome`) — never re-derived from "now" at publish time, so a delayed retry still targets the intended week.

## Meta Graph API version

Verified directly against Meta's official changelog (`developers.facebook.com/docs/graph-api/changelog` and `.../guides/versioning`) on 2026-09-05: **v26.0** is the current released version (July 29, 2026); each version stays available for at least two years from release, and v23.0 and earlier have already reached end of life. v26.0's own changes (blocked commerce endpoints, ad-placement changes) do not affect `POST /{page-id}/feed` or the Instagram Content Publishing endpoints (`/{ig-user-id}/media`, `/{ig-user-id}/media_publish`) this module calls. The version is a single named constant in `meta-client.ts` (`GRAPH_API_VERSION`), shared by Facebook and Instagram — not a literal scattered across files — update it there, next time it's re-verified, not reflexively.

## Credential model — deliberately simpler than MIE's OAuth flow

Unlike `marketing`'s Google OAuth connection (a per-tenant refresh token stored encrypted in `marketing_connections`, because that flow lets the founder connect/reconnect via a UI), this module has no OAuth callback route and no DB-stored credential at all: `FACEBOOK_PAGE_ID` and `FACEBOOK_PAGE_ACCESS_TOKEN` are plain environment variables, read directly by `meta-client.ts`, exactly like `ANTHROPIC_API_KEY` and `RESEND_API_KEY` already are elsewhere in this codebase. This is a deliberate simplification from the originally-discussed plan (which proposed a `SOCIAL_TOKEN_ENCRYPTION_KEY` to encrypt the token at rest in the database): there is no per-tenant OAuth grant to store here, a long-lived Page Access Token is a single founder-provisioned secret, and the platform's own environment-variable storage (the same mechanism already trusted for every other API key in this codebase) is the existing, sufficient boundary — adding a second, DB-level encryption layer for a value that never touches the database would be complexity without a matching real requirement. Revisit only if this module ever needs a real per-tenant OAuth flow (multi-tenant Page connections), which it doesn't today (see `docs/adr/0004-tenant-id-multitenancy.md` — everything here is still written tenant-scoped regardless).

`FACEBOOK_PAGE_ID`/`FACEBOOK_PAGE_ACCESS_TOKEN` are intentionally **not yet set** anywhere (not even `.env.local`) — see `.env.example`'s own comments for how to obtain a long-lived Page Access Token from the existing Meta App (the one already used for WhatsApp — see `packages/core/src/whatsapp/README.md`), pending the founder's review of this code first.

### Instagram — no second token, two new non-secret values

Instagram Graph API content publishing is authenticated with the same `FACEBOOK_PAGE_ACCESS_TOKEN` above, once `instagram_basic` + `instagram_content_publish` are also granted on the same Page/Meta App — there is no separate Instagram access token to store or configure. Two new environment variables were added instead, neither of them a secret:

- `INSTAGRAM_BUSINESS_ACCOUNT_ID` — the Instagram Business Account's id, found via `GET /{FACEBOOK_PAGE_ID}?fields=instagram_business_account` once the Instagram account is linked to the Page.
- `INSTAGRAM_POST_IMAGE_URL` — a permanent, publicly reachable URL to a real, official Bonolini Transfer photo. Deliberately **not** chosen or fetched automatically by this module's code (e.g. the Page's current profile picture) — the founder picks the exact real photo, exactly as they will pick the Page Access Token above, rather than code guessing what counts as "official." Instagram has no text-only post type, so this is mandatory for every Instagram publish; when unset, Instagram publishing is skipped, not treated as an error (see `service.ts`'s `publishToInstagram`).

Both are intentionally **not yet set** anywhere, pending the founder's review of this code first — see `.env.example`'s own comments.

## Hard constraints (do not relax without the founder reopening this decision)

- Never publishes client names, phone numbers, emails, individual prices, or any personal data — none of it is ever read into a data snapshot in the first place.
- Never publishes aggregate revenue or business-volume/booking-count figures.
- Never invents a testimonial, review, rating, or statistic.
- At most one post per tenant per week, per platform — enforced at the DB level, not just in application logic.
- Instagram is never published without a real image (`INSTAGRAM_POST_IMAGE_URL`), and that image is always a real, founder-chosen official brand photo — never a stock photo, placeholder, or AI-generated image.
- A failure, or missing configuration, on one platform (Facebook or Instagram) never blocks or overwrites the other platform's own outcome on the same row.
- No automated test in this module's test suite ever calls the real Meta Graph API or the real Anthropic API — both are mocked at the module boundary (see `meta-client.test.ts`/`content-generator.test.ts`).
