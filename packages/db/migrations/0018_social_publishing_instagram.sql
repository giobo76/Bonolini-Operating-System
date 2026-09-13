-- Bonolini OS — Instagram publishing alongside the existing weekly Facebook
-- Page post (social-publishing module)
--
-- Hand-written to match drizzle-kit's own output format (this environment
-- could not run `pnpm --filter @bos/db run generate` — no network access to
-- the npm registry from the sandbox that authored this migration; the SQL
-- below was checked by hand against packages/db/src/schema/social-publishing.ts
-- instead). Please re-run `pnpm db:generate` locally before applying to
-- confirm drizzle-kit computes the same diff, and replace this file if not.
--
-- Adds independent Instagram tracking columns to the existing social_posts
-- table (see 0016_social_publishing.sql) rather than a new table — one
-- generated post is now published to two platforms, but it is still one
-- row per tenant per calendar week (the existing
-- UNIQUE(tenant_id, week_start_date) constraint is untouched). Facebook's
-- own "status"/"meta_post_id"/"meta_error" columns are untouched for
-- backward compatibility; Instagram gets its own independent
-- "instagram_status" (default 'skipped', not 'failed' — unconfigured is not
-- an error) so one platform's outcome never overwrites or is conflated with
-- the other's — see
-- packages/core/src/social-publishing/service.ts's runWeeklySocialPost.
--
-- NOT YET APPLIED to any database as of this commit — pending the founder's
-- review and a manual run of the "DB Migrate — Production" GitHub Actions
-- workflow (packages/core/src/social-publishing/README.md).

CREATE TYPE "public"."social_post_instagram_status" AS ENUM('skipped', 'validated', 'published', 'failed');--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "instagram_status" "social_post_instagram_status" DEFAULT 'skipped' NOT NULL;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "instagram_media_id" text;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "instagram_error" text;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "instagram_published_at" timestamp with time zone;
