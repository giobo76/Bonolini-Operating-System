import { pgTable, uuid, text, timestamp, jsonb, pgEnum, integer, unique } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { profiles } from "./profiles";

// BOS Agent orchestrator persistence — see packages/core/src/bos-agent's
// README for the EVENT -> PERCEPTION -> DECISION -> POLICY CHECK -> ACTION
// -> VERIFICATION -> AUDIT loop these tables record. Additive only: no
// existing table is touched.

export const agentRunTriggerEnum = pgEnum("agent_run_trigger", ["manual", "cron", "event"]);

// Mirrors check_run_status's running/completed/failed shape (marketing.ts),
// extended with the two outcomes unique to a policy-gated agent run.
export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "running",
  "success",
  "failed",
  "pending_approval",
  "denied",
]);

// Mirrors @bos/ai's policy.ts riskLevels exactly — kept as two independent
// declarations (not one shared import) on purpose: @bos/db must not depend
// on @bos/ai (it's the other way around), same dependency direction every
// other package in this repo already follows.
export const agentRiskLevelEnum = pgEnum("agent_risk_level", [
  "read_only",
  "low_risk",
  "reversible",
  "requires_approval",
  "high_risk",
  "forbidden",
]);

// "approved" means the human decision was made; "executed"/
// "execution_failed" (added for V2) record the outcome of actually running
// the tool afterwards — previously conflated into a single "approved"
// forever, even after execution succeeded or failed. Existing rows already
// at "approved" remain valid (a V1 approval whose execution outcome was
// never retrofitted) — nothing back-fills them, nothing requires it.
export const agentApprovalStatusEnum = pgEnum("agent_approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
  "executed",
  "execution_failed",
]);

// One row per orchestration cycle. agent_name/tool_name are plain text, not
// enums — new agents/tools are expected to be added often as this system
// grows, and an enum would mean a migration for every one (see ADR 0002 on
// keeping module additions cheap).
export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  agentName: text("agent_name").notNull(),
  trigger: agentRunTriggerEnum("trigger").notNull(),
  eventType: text("event_type"),
  // Threads one logical operation across multiple runs/events (e.g. the
  // same transfer_request id, or a fresh uuid for a manual/cron trigger)
  // — the same value an emitted domain event and the run(s) it causes
  // share, so the admin UI and any future replay/dedup logic can group
  // them. Not unique by itself: several runs (e.g. a cron sweep over many
  // tenants, or an event and the approval-triggered follow-up run it
  // causes) legitimately share one.
  correlationId: text("correlation_id"),
  status: agentRunStatusEnum("status").notNull().default("running"),
  // Each stage of the loop, captured as it completes — never overwritten
  // once set, only added to as the run progresses. Nullable because a run
  // can stop at any stage (e.g. denied at POLICY CHECK never reaches
  // verification).
  input: jsonb("input"),
  perception: jsonb("perception"),
  decision: jsonb("decision"),
  policyResult: jsonb("policy_result"),
  toolName: text("tool_name"),
  action: jsonb("action"),
  verification: jsonb("verification"),
  // What this run read from / wrote to agent_memory — e.g.
  // { read: [{namespace,key}], wrote: [{namespace,key,summary}] }. Never
  // the full memory value (that's in agent_memory itself, readable via its
  // own tenant-scoped API) — just enough for the admin UI's "what did the
  // agent remember?" view without duplicating the memory table's content.
  memoryOps: jsonb("memory_ops"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

// requested_action/reason/payload describe what a human is being asked to
// approve; agent_run_id is the one-directional link back to the run that
// created this request (no reverse column on agent_runs, to avoid a
// circular FK between the two tables in the same migration — look up via
// `where agent_run_id = ...` instead).
export const agentApprovals = pgTable("agent_approvals", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  agentRunId: uuid("agent_run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  // Denormalized from the originating run for quick filtering/display
  // without a join — the run remains the source of truth.
  correlationId: text("correlation_id"),
  // Derived from the tool's own getIdempotencyKey(payload) (see @bos/ai's
  // ToolDefinition) — lets the orchestrator detect and skip creating a
  // second pending approval for the same underlying action while one
  // already exists, instead of piling up duplicates every time a cron/
  // event run re-proposes the same fix.
  idempotencyKey: text("idempotency_key"),
  requestedAction: text("requested_action").notNull(),
  risk: agentRiskLevelEnum("risk").notNull(),
  reason: text("reason").notNull(),
  payload: jsonb("payload"),
  status: agentApprovalStatusEnum("status").notNull().default("pending"),
  approvedBy: uuid("approved_by").references(() => profiles.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Backs @bos/ai's SharedMemory interface (get/set/delete/list(namespace,
// key)) — see packages/core/src/bos-agent/db-memory.ts's DbSharedMemory,
// the production replacement for @bos/ai's InMemorySharedMemory (which
// loses all state between Vercel serverless invocations). The unique
// constraint below is both the natural key and the tenant-isolation
// guarantee: every read/write is always scoped by (tenant_id, namespace,
// key) together, never by key alone.
export const agentMemory = pgTable(
  "agent_memory",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantNamespaceKeyUnique: unique("agent_memory_tenant_namespace_key_unique").on(
      table.tenantId,
      table.namespace,
      table.key,
    ),
  }),
);

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
export type AgentApproval = typeof agentApprovals.$inferSelect;
export type NewAgentApproval = typeof agentApprovals.$inferInsert;
export type AgentMemoryRow = typeof agentMemory.$inferSelect;
export type NewAgentMemoryRow = typeof agentMemory.$inferInsert;
