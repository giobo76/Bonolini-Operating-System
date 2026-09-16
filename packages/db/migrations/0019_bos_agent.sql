-- Bonolini OS — BOS Agent persistence (agent_runs / agent_approvals /
-- agent_memory)
--
-- Generated via `pnpm --filter @bos/db run generate`, then hand-edited:
-- drizzle-kit's own snapshot bookkeeping is stale past migration 0009 (same
-- pre-existing, accepted state migration 0018's own header documents), so
-- the raw generate output incorrectly re-included social_posts'
-- instagram_* columns as "new" — those already exist via
-- 0018_social_publishing_instagram.sql, applied earlier in the sequence,
-- and have been removed from this file. Renamed from drizzle-kit's own
-- 0011_bitter_santa_claus.sql to match this project's real, continuous
-- migration numbering — same convention every migration since 0014
-- documents. Journal entry idx 11 corrected to match; meta snapshot files
-- deliberately left as-is (same accepted gap 0018 already carries forward).
--
-- Purely additive: three new tables, five new enums, no ALTER on any
-- existing table. See packages/core/src/bos-agent/README.md for what these
-- back.

CREATE TYPE "public"."agent_approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."agent_risk_level" AS ENUM('read_only', 'low_risk', 'reversible', 'requires_approval', 'high_risk', 'forbidden');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'success', 'failed', 'pending_approval', 'denied');--> statement-breakpoint
CREATE TYPE "public"."agent_run_trigger" AS ENUM('manual', 'cron', 'event');--> statement-breakpoint
CREATE TABLE "agent_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"requested_action" text NOT NULL,
	"risk" "agent_risk_level" NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb,
	"status" "agent_approval_status" DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_tenant_namespace_key_unique" UNIQUE("tenant_id","namespace","key")
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_name" text NOT NULL,
	"trigger" "agent_run_trigger" NOT NULL,
	"event_type" text,
	"status" "agent_run_status" DEFAULT 'running' NOT NULL,
	"input" jsonb,
	"perception" jsonb,
	"decision" jsonb,
	"policy_result" jsonb,
	"tool_name" text,
	"action" jsonb,
	"verification" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_approved_by_profiles_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
