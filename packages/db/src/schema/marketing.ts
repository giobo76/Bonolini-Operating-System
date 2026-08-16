import { pgTable, uuid, text, timestamp, pgEnum, boolean, smallint, jsonb } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { profiles } from "./profiles";
import { clients } from "./clients";

export const marketingConnectionStatusEnum = pgEnum("marketing_connection_status", [
  "active",
  "needs_reauth",
  "revoked",
]);

export const marketingResourceTypeEnum = pgEnum("marketing_resource_type", [
  "google_ads_account",
  "ga4_property",
  "gtm_container",
  "search_console_site",
]);

// One row per tenant (unique tenantId) — a single Google OAuth grant. The
// refresh token is the only long-lived credential; access tokens are minted
// on demand from it and never persisted. See ./encryption.ts.
export const marketingConnections = pgTable("marketing_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
  grantedScopes: text("granted_scopes").array().notNull(),
  connectedBy: uuid("connected_by").references(() => profiles.id, { onDelete: "set null" }),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  status: marketingConnectionStatusEnum("status").notNull().default("active"),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Which specific accounts/properties/containers/sites under the connected
// Google account are actually monitored. Hard-deleted on removal — these
// are configuration pointers, not business records with history value
// (unlike clients, which are soft-deleted).
export const marketingLinkedResources = pgTable("marketing_linked_resources", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => marketingConnections.id, { onDelete: "cascade" }),
  resourceType: marketingResourceTypeEnum("resource_type").notNull(),
  externalId: text("external_id").notNull(),
  displayName: text("display_name"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MarketingConnection = typeof marketingConnections.$inferSelect;
export type MarketingLinkedResource = typeof marketingLinkedResources.$inferSelect;

// ── Findings, health score, check runs ──────────────────────────────────
// Added before MIE-2's detection logic exists, on purpose: this is the
// data model the "think like a CMO" requirement shapes. MIE-2 populates
// these tables; nothing writes to them yet.

export const checkRunTypeEnum = pgEnum("check_run_type", [
  "quick_check",
  "daily_audit",
  "weekly_report",
  "on_demand",
]);

export const checkRunStatusEnum = pgEnum("check_run_status", [
  "running",
  "completed",
  "failed",
]);

export const checkRuns = pgTable("check_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  runType: checkRunTypeEnum("run_type").notNull(),
  status: checkRunStatusEnum("status").notNull().default("running"),
  triggeredBy: uuid("triggered_by").references(() => profiles.id, { onDelete: "set null" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  summary: text("summary"),
  errorMessage: text("error_message"),
});

// Every category a finding can be filed under. Deliberately broad —
// covers the full monitoring checklist agreed for MIE-2, even though no
// rule produces most of these yet.
export const findingCategoryEnum = pgEnum("finding_category", [
  "conversion_tracking",
  "duplicate_conversions",
  "attribution",
  "gtm_configuration",
  "budget_pacing",
  "budget_waste",
  "bid_cpc_anomaly",
  "quality_score",
  "impression_share",
  "policy_compliance",
  "account_health",
  "landing_page_availability",
  "page_speed",
  "core_web_vitals",
  "search_console_indexing",
  "organic_traffic",
  "form_tracking",
  "call_tracking",
  "whatsapp_tracking",
  "competitor_observation",
  "other",
]);

// The CMO-level distinction the founder required: a technical issue is
// active harm (broken tracking, downtime, policy risk) and drags the
// Health Score down hard; a strategic opportunity is unrealized upside and
// is tracked separately as "opportunity value," not folded into the score
// the same way. See packages/core/src/marketing/health-score.ts.
export const findingNatureEnum = pgEnum("finding_nature", [
  "technical_issue",
  "strategic_opportunity",
]);

export const findingSeverityEnum = pgEnum("finding_severity", [
  "critical",
  "high",
  "medium",
  "low",
]);

export const findingStatusEnum = pgEnum("finding_status", [
  "open",
  "acknowledged",
  "resolved",
  "dismissed",
]);

export const findings = pgTable("findings", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  checkRunId: uuid("check_run_id").references(() => checkRuns.id, { onDelete: "set null" }),
  category: findingCategoryEnum("category").notNull(),
  nature: findingNatureEnum("nature").notNull(),
  severity: findingSeverityEnum("severity").notNull(),
  confidenceScore: smallint("confidence_score").notNull(),
  title: text("title").notNull(),
  // "Observation / Diagnosis / Business impact / Recommendation" — the
  // founder's required structure, named to match exactly.
  observation: text("observation").notNull(),
  rootCause: text("root_cause"),
  businessImpact: text("business_impact").notNull(),
  // Shape: { amount: number | null, currency, period: one_time|daily|weekly|monthly,
  // direction: cost|opportunity, note? } — validated in packages/core/src/marketing/schema.ts,
  // not at the DB level (same pattern as bookings' price_breakdown).
  financialImpact: jsonb("financial_impact"),
  recommendedActions: jsonb("recommended_actions").notNull().default([]),
  requiresApproval: boolean("requires_approval").notNull().default(false),
  expectedBenefit: text("expected_benefit"),
  evidence: jsonb("evidence"),
  status: findingStatusEnum("status").notNull().default("open"),
  firstDetectedAt: timestamp("first_detected_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  // Consecutive covered-and-completed check runs in which this open
  // finding's dedupeKey went undetected — see run-check.ts's auto-resolution
  // logic. Reset to 0 whenever the finding is (re)detected; reaching 2
  // auto-resolves it. Never incremented for a run that didn't actually cover
  // this finding's check, that errored on the underlying resource, or whose
  // resource is no longer active — see isEligibleForMissTracking.
  missedCount: smallint("missed_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A snapshot, not a live-only computation — so the historical timeline
// survives even as the findings that produced a past score get resolved.
export const marketingHealthScores = pgTable("marketing_health_scores", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  checkRunId: uuid("check_run_id").references(() => checkRuns.id, { onDelete: "set null" }),
  overallScore: smallint("overall_score").notNull(),
  // { trackingIntegrity, accountHealth, efficiency, technicalSiteHealth } — see health-score.ts
  breakdown: jsonb("breakdown").notNull(),
  // Unrealized upside from open strategic_opportunity findings, kept
  // separate from the score itself.
  opportunityValue: jsonb("opportunity_value"),
  summary: text("summary"),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

// Weekly executive report — a narrative artifact (Claude-synthesized),
// archived so past reports stay readable even as findings resolve.
export const reports = pgTable("reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  content: text("content").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  emailedAt: timestamp("emailed_at", { withTimezone: true }),
});

export type CheckRun = typeof checkRuns.$inferSelect;
export type Finding = typeof findings.$inferSelect;
export type MarketingHealthScore = typeof marketingHealthScores.$inferSelect;
export type Report = typeof reports.$inferSelect;

// ── Marketing leads (anonymous intent capture) ───────────────────────────
// bonolinitransfer.com's real conversion funnel is WhatsApp/phone/email
// click-to-contact, not a web form (see the funnel design audit) — a click
// carries no name/phone/email, so it can't be a `clients` row (full_name/
// phone are NOT NULL there, and placeholder data is explicitly ruled out).
// Kept separate from `clients` per ADR 0002: this is a marketing-domain
// fact (top-of-funnel intent), not a customer record. `clientId` is set
// only when a staff member manually links this intent to a real client
// (linkLeadToClient) — never during public creation, and never by
// automatic name/phone matching (neither is known at click time).

export const marketingLeadChannelEnum = pgEnum("marketing_lead_channel", [
  "whatsapp",
  "phone",
  "email",
  "form",
]);

export const marketingLeadStatusEnum = pgEnum("marketing_lead_status", [
  "new",
  "contacted",
  "converted",
  "discarded",
]);

export const marketingLeads = pgTable("marketing_leads", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  channel: marketingLeadChannelEnum("channel").notNull(),
  status: marketingLeadStatusEnum("status").notNull().default("new"),
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
  landingPage: text("landing_page"),
  referrer: text("referrer"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmTerm: text("utm_term"),
  utmContent: text("utm_content"),
  gclid: text("gclid"),
  // First-party, browser-generated id (not a cross-site cookie) — groups
  // multiple intents from the same visitor before conversion.
  visitorId: text("visitor_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MarketingLead = typeof marketingLeads.$inferSelect;
export type NewMarketingLead = typeof marketingLeads.$inferInsert;
