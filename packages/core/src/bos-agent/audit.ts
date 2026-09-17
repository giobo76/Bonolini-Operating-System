import { and, desc, eq } from "drizzle-orm";
import { getDb, agentRuns, assertOne, type AgentRun } from "@bos/db";

// The persisted half of the AUDIT step — every stage of a run
// (PERCEPTION/DECISION/POLICY CHECK/ACTION/VERIFICATION) is written here as
// it completes, never only logged to console (see packages/core/src/
// observability.ts's own header comment: console output is not persisted
// anywhere). orchestrator.ts is the only caller of these functions; nothing
// else should write to agent_runs directly.

export interface CreateRunInput {
  tenantId: string;
  agentName: string;
  trigger: "manual" | "cron" | "event";
  eventType?: string;
  correlationId?: string;
  input: Record<string, unknown>;
}

export async function createRun(input: CreateRunInput): Promise<AgentRun> {
  const db = getDb();
  const rows = await db
    .insert(agentRuns)
    .values({
      tenantId: input.tenantId,
      agentName: input.agentName,
      trigger: input.trigger,
      eventType: input.eventType,
      correlationId: input.correlationId,
      input: input.input,
      status: "running",
    })
    .returning();
  return assertOne(rows, "createRun");
}

export async function updateRun(
  tenantId: string,
  runId: string,
  patch: Partial<
    Pick<AgentRun, "perception" | "decision" | "policyResult" | "toolName" | "action" | "verification" | "memoryOps">
  >,
): Promise<AgentRun> {
  const db = getDb();
  const rows = await db
    .update(agentRuns)
    .set(patch)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)))
    .returning();
  return assertOne(rows, "updateRun");
}

export async function completeRun(
  tenantId: string,
  runId: string,
  status: "success" | "failed" | "pending_approval" | "denied",
  patch: Partial<Pick<AgentRun, "verification" | "error" | "action" | "policyResult" | "toolName" | "memoryOps">> = {},
): Promise<AgentRun> {
  const db = getDb();
  const rows = await db
    .update(agentRuns)
    .set({ ...patch, status, completedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)))
    .returning();
  return assertOne(rows, "completeRun");
}

export async function getRun(tenantId: string, runId: string): Promise<AgentRun | null> {
  const db = getDb();
  const rows = await db.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.tenantId, tenantId)));
  return rows[0] ?? null;
}

export async function listRuns(tenantId: string, limit = 20): Promise<AgentRun[]> {
  const db = getDb();
  return db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.tenantId, tenantId))
    .orderBy(desc(agentRuns.startedAt))
    .limit(limit);
}
