-- Bonolini OS — BOS Business Intelligence + Autonomy Model, Phase 1:
-- Business Rules + Versioning + Evidence/Provenance
--
-- Generated via `pnpm --filter @bos/db run generate`, then hand-edited for
-- the same reason every migration since 0018 documents: drizzle-kit's
-- snapshot bookkeeping is stale past migration 0009, so the raw generate
-- output re-included the full CREATE TYPE/CREATE TABLE for
-- agent_approval_status/agent_risk_level/agent_run_status/agent_run_trigger/
-- agent_approvals/agent_memory/agent_runs (already created by 0019) and
-- social_posts' instagram_* columns/enum (already added by 0018) as if
-- they were new. Only the genuine delta below survives: 4 new tables
-- (business_rules, business_rule_versions, business_rule_version_evidence,
-- evidence), their 6 new enum types, and their own foreign keys. Purely
-- additive — no existing table/column/enum is touched.

CREATE TYPE "public"."evidence_confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."evidence_type" AS ENUM('fact', 'calculation', 'hypothesis', 'recommendation');--> statement-breakpoint
CREATE TYPE "public"."business_rule_category" AS ENUM('pricing', 'commercial_relevance', 'commission_platform', 'seasonality', 'priority_weights', 'other');--> statement-breakpoint
CREATE TYPE "public"."business_rule_owner_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."business_rule_version_author" AS ENUM('owner', 'bos_agent');--> statement-breakpoint
CREATE TYPE "public"."business_rule_version_status" AS ENUM('proposed', 'approved', 'rejected', 'effective', 'superseded');--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"source" text NOT NULL,
	"query_or_call" jsonb,
	"raw_observation" jsonb NOT NULL,
	"calculation" jsonb,
	"conclusion" text NOT NULL,
	"evidence_type" "evidence_type" NOT NULL,
	"confidence" "evidence_confidence" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_rule_version_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_rule_version_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_rule_version_evidence_unique" UNIQUE("business_rule_version_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "business_rule_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "business_rule_version_status" DEFAULT 'proposed' NOT NULL,
	"content" jsonb NOT NULL,
	"author" "business_rule_version_author" NOT NULL,
	"proposal_reasoning" text,
	"owner_decision" "business_rule_owner_decision",
	"owner_decision_reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"effective_from" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_rule_versions_rule_version_number_unique" UNIQUE("rule_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "business_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"category" "business_rule_category" NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_rules_tenant_key_unique" UNIQUE("tenant_id","key")
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_rule_version_evidence" ADD CONSTRAINT "business_rule_version_evidence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_rule_version_evidence" ADD CONSTRAINT "business_rule_version_evidence_business_rule_version_id_business_rule_versions_id_fk" FOREIGN KEY ("business_rule_version_id") REFERENCES "public"."business_rule_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_rule_version_evidence" ADD CONSTRAINT "business_rule_version_evidence_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_rule_versions" ADD CONSTRAINT "business_rule_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_rule_versions" ADD CONSTRAINT "business_rule_versions_rule_id_business_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."business_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_rule_versions" ADD CONSTRAINT "business_rule_versions_decided_by_profiles_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_rules" ADD CONSTRAINT "business_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
