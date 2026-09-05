-- Bonolini OS — automated weekly Facebook Page post (social-publishing
-- module)
--
-- Generated via `pnpm --filter @bos/db run generate`, then renamed from
-- drizzle-kit's own 0008_watery_tiger_shark.sql to match this project's
-- real, continuous migration numbering — same convention 0014/0015's own
-- header comments document. Journal entry idx 8 updated to match;
-- meta/0008_snapshot.json deliberately left with drizzle-kit's own
-- idx-based filename.
--
-- social_posts: one row per tenant per calendar week. The
-- UNIQUE(tenant_id, week_start_date) constraint below is the real
-- idempotency boundary for "at most one post per week" — enforced by
-- Postgres, not just by application logic — see
-- packages/core/src/social-publishing/service.ts's ensureWeeklyPostRow
-- (INSERT ... ON CONFLICT DO NOTHING against this exact constraint).
--
-- NOT YET APPLIED to any database as of this commit — this is the
-- migration file only, pending the founder's review before `pnpm db:migrate`
-- is run against any real environment (see the module's README.md).

CREATE TYPE "public"."social_post_status" AS ENUM('draft', 'validated', 'published', 'failed');--> statement-breakpoint
CREATE TABLE "social_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"week_start_date" date NOT NULL,
	"status" "social_post_status" DEFAULT 'draft' NOT NULL,
	"content" text,
	"language" text DEFAULT 'en' NOT NULL,
	"data_snapshot" jsonb,
	"meta_post_id" text,
	"meta_error" text,
	"generated_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_posts_tenant_week_unique" UNIQUE("tenant_id","week_start_date")
);
--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;