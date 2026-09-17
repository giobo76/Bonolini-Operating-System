-- Bonolini OS — BOS Agent V2: correlation id, memory-ops audit trail, and
-- approval execution outcomes
--
-- Generated via `pnpm --filter @bos/db run generate`, then hand-edited for
-- the same reason every migration since 0018 documents: drizzle-kit's
-- snapshot bookkeeping is stale past migration 0009, so the raw generate
-- output re-included the full CREATE TABLE for agent_runs/agent_approvals/
-- agent_memory (already created by 0019) and social_posts' instagram_*
-- columns (already added by 0018) as if they were new. Only the genuine
-- delta below survives. Purely additive: new nullable columns and two new
-- enum values, no ALTER on any existing column, no data touched.

ALTER TYPE "public"."agent_approval_status" ADD VALUE 'executed';--> statement-breakpoint
ALTER TYPE "public"."agent_approval_status" ADD VALUE 'execution_failed';--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "correlation_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "memory_ops" jsonb;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD COLUMN "correlation_id" text;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD COLUMN "idempotency_key" text;
