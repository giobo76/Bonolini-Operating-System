import { pgTable, uuid, text, timestamp, jsonb, pgEnum, integer, unique } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { profiles } from "./profiles";
import { evidence } from "./evidence";

// BOS Business Intelligence + Autonomy Model, Phase 1 — the governance
// layer the gap analysis's Section C proposed: business rules the founder
// owns exclusively, versioned, with a strict, auditable state machine. The
// BOS Agent can read/apply/analyze/propose; only the founder (admin) can
// approve, reject, or make a version effective — enforced at the
// application layer (business-rules/service.ts) and at the tRPC layer
// (business-rules/router.ts's adminProcedure-gated mutations), never by a
// DB constraint alone (Postgres has no concept of "which application code
// path" wrote a row).

export const businessRuleCategoryEnum = pgEnum("business_rule_category", [
  "pricing",
  "commercial_relevance",
  "commission_platform",
  "seasonality",
  "priority_weights",
  "other",
]);

// The full lifecycle a version can occupy. "approved" is a real,
// independently reachable state (the founder said yes) distinct from
// "effective" (this is now the official, current version) — Phase 1's
// approve action performs both transitions in one call (no UI/requirement
// yet for approving now and activating later), but the two are validated
// as separate steps internally so a future phase can split them without
// redesigning this enum. "superseded" is never a direct target of a human
// action — it only happens as a side effect of a different version
// becoming "effective" (see business-rules/service.ts).
export const businessRuleVersionStatusEnum = pgEnum("business_rule_version_status", [
  "proposed",
  "approved",
  "rejected",
  "effective",
  "superseded",
]);

export const businessRuleVersionAuthorEnum = pgEnum("business_rule_version_author", ["owner", "bos_agent"]);

export const businessRuleOwnerDecisionEnum = pgEnum("business_rule_owner_decision", ["approved", "rejected"]);

// One row per named rule the business runs on (e.g.
// "pricing.fixed_fare.malpensa_airport"). Deliberately created only by the
// founder (business-rules/service.ts's createBusinessRule is admin-only at
// the router level) — the rule's very existence/key/category is itself a
// business decision, not something the BOS invents unilaterally. The BOS
// can only ever propose a new *version* of an already-existing rule (see
// businessRuleVersions below).
export const businessRules = pgTable(
  "business_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    category: businessRuleCategoryEnum("category").notNull(),
    // Deliberately NOT a real FK constraint to business_rule_versions.id —
    // same reasoning agent.ts documents for agent_approvals/agent_runs:
    // avoiding a circular FK between two tables created in the same
    // migration (business_rule_versions.ruleId already points back at this
    // table, so a reverse FK here would form a cycle). Enforced instead at
    // the application layer, which is also the only thing that ever writes
    // to this column (business-rules/service.ts's approve flow).
    currentVersionId: uuid("current_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantKeyUnique: unique("business_rules_tenant_key_unique").on(table.tenantId, table.key),
  }),
);

// Every proposed/decided value a rule has ever had — immutable once a
// decision is recorded (decidedAt set): nothing in this codebase ever
// updates `content`, `proposalReasoning`, or `author` after insert, and
// service.ts never exposes a function that could. The only columns that
// ever change after insert are status/ownerDecision/ownerDecisionReason/
// decidedAt/effectiveFrom — the decision lifecycle, not the proposal's own
// content.
export const businessRuleVersions = pgTable(
  "business_rule_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => businessRules.id, { onDelete: "cascade" }),
    // Incremental per rule, never reused — allocated by service.ts as
    // MAX(version_number)+1 for the rule, with the unique constraint below
    // as a hard backstop against a race producing two versions with the
    // same number.
    versionNumber: integer("version_number").notNull(),
    status: businessRuleVersionStatusEnum("status").notNull().default("proposed"),
    content: jsonb("content").notNull(),
    author: businessRuleVersionAuthorEnum("author").notNull(),
    // Present only when author='bos_agent' in practice (never enforced by
    // a DB constraint, since a founder-authored version could in principle
    // carry its own note too) — why the BOS is proposing this version.
    proposalReasoning: text("proposal_reasoning"),
    ownerDecision: businessRuleOwnerDecisionEnum("owner_decision"),
    // Required for a rejection, optional for an approval — enforced in
    // service.ts (rejectBusinessRuleVersion requires a non-empty reason),
    // not by a DB constraint (a DB CHECK can't cross-reference which
    // decision column was set without a trigger, which this codebase does
    // not use anywhere).
    ownerDecisionReason: text("owner_decision_reason"),
    decidedBy: uuid("decided_by").references(() => profiles.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // Set when this version actually becomes the rule's current version
    // (status -> "effective") — never backdated, never set for a version
    // that stays at "approved" only.
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ruleVersionNumberUnique: unique("business_rule_versions_rule_version_number_unique").on(
      table.ruleId,
      table.versionNumber,
    ),
  }),
);

// Many-to-many: a recommendation/proposal can cite more than one piece of
// evidence, and a single piece of evidence (e.g. one Google Ads query
// result) can support more than one proposal. tenantId is denormalized
// here too (not just reachable via a join) for the same reason
// agent_approvals denormalizes correlationId from its run — quick,
// unambiguous tenant-scoped filtering without a join, and a second,
// independent tenant-isolation check at this table's own level.
export const businessRuleVersionEvidence = pgTable(
  "business_rule_version_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessRuleVersionId: uuid("business_rule_version_id")
      .notNull()
      .references(() => businessRuleVersions.id, { onDelete: "cascade" }),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    versionEvidenceUnique: unique("business_rule_version_evidence_unique").on(
      table.businessRuleVersionId,
      table.evidenceId,
    ),
  }),
);

export type BusinessRule = typeof businessRules.$inferSelect;
export type NewBusinessRule = typeof businessRules.$inferInsert;
export type BusinessRuleVersion = typeof businessRuleVersions.$inferSelect;
export type NewBusinessRuleVersion = typeof businessRuleVersions.$inferInsert;
export type BusinessRuleVersionEvidence = typeof businessRuleVersionEvidence.$inferSelect;
