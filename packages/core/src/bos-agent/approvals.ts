import { and, desc, eq } from "drizzle-orm";
import { getDb, agentApprovals, assertOne, type AgentApproval } from "@bos/db";
import type { RiskLevel } from "@bos/ai";

// Generalizes transfer-requests' pending_admin_approval -> ACCEPT/REJECT
// pattern (packages/core/src/transfer-requests/service.ts) into a single
// table any agent tool can use, instead of every module growing its own
// bespoke approval columns. Idempotency discipline: approving an
// already-approved row (or rejecting an already-rejected one) is a safe
// no-op that returns the existing row, never a silent overwrite of a
// different outcome. V2 adds "executed"/"execution_failed" so an approval
// reflects the real outcome of running the tool, not just the human
// decision — see orchestrator.ts's approveAndExecute for the single place
// that owns this whole state machine (never split across two callers,
// which is exactly what would let a double-click re-execute a tool).

export interface CreateApprovalInput {
  tenantId: string;
  agentRunId: string;
  requestedAction: string;
  risk: RiskLevel;
  reason: string;
  payload?: unknown;
  correlationId?: string;
  idempotencyKey?: string;
}

export async function createApproval(input: CreateApprovalInput): Promise<AgentApproval> {
  const db = getDb();
  const rows = await db
    .insert(agentApprovals)
    .values({
      tenantId: input.tenantId,
      agentRunId: input.agentRunId,
      requestedAction: input.requestedAction,
      risk: input.risk,
      reason: input.reason,
      payload: input.payload,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      status: "pending",
    })
    .returning();
  return assertOne(rows, "createApproval");
}

export async function getApproval(tenantId: string, id: string): Promise<AgentApproval | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(agentApprovals)
    .where(and(eq(agentApprovals.id, id), eq(agentApprovals.tenantId, tenantId)));
  return rows[0] ?? null;
}

// Dedup check the orchestrator runs before creating a new approval — if an
// identical action (same tool, same idempotency key) already has a
// pending or already-decided approval, a cron/event re-proposing it must
// not pile up a duplicate row. Only ever matches within the same tenant.
export async function findApprovalByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<AgentApproval | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(agentApprovals)
    .where(and(eq(agentApprovals.tenantId, tenantId), eq(agentApprovals.idempotencyKey, idempotencyKey)))
    .orderBy(desc(agentApprovals.createdAt));
  return rows[0] ?? null;
}

export async function listPendingApprovals(tenantId: string, limit = 50): Promise<AgentApproval[]> {
  const db = getDb();
  return db
    .select()
    .from(agentApprovals)
    .where(and(eq(agentApprovals.tenantId, tenantId), eq(agentApprovals.status, "pending")))
    .orderBy(desc(agentApprovals.createdAt))
    .limit(limit);
}

export async function markApproved(tenantId: string, id: string, approvedByProfileId: string): Promise<AgentApproval> {
  const db = getDb();
  const existing = await getApproval(tenantId, id);
  if (!existing) {
    throw new Error(`markApproved: no agent_approval found for id ${id}`);
  }
  if (existing.status === "approved" || existing.status === "executed" || existing.status === "execution_failed") {
    return existing;
  }
  if (existing.status !== "pending") {
    throw new Error(`markApproved: agent_approval ${id} is '${existing.status}', not 'pending'`);
  }

  const rows = await db
    .update(agentApprovals)
    .set({ status: "approved", approvedBy: approvedByProfileId, approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(agentApprovals.id, id))
    .returning();
  return assertOne(rows, "markApproved");
}

export async function markRejected(tenantId: string, id: string): Promise<AgentApproval> {
  const db = getDb();
  const existing = await getApproval(tenantId, id);
  if (!existing) {
    throw new Error(`markRejected: no agent_approval found for id ${id}`);
  }
  if (existing.status === "rejected") {
    return existing;
  }
  if (existing.status !== "pending") {
    throw new Error(`markRejected: agent_approval ${id} is '${existing.status}', not 'pending'`);
  }

  const rows = await db
    .update(agentApprovals)
    .set({ status: "rejected", rejectedAt: new Date(), updatedAt: new Date() })
    .where(eq(agentApprovals.id, id))
    .returning();
  return assertOne(rows, "markRejected");
}

// Only ever called from orchestrator.ts's approveAndExecute, immediately
// after the tool actually ran — never a standalone "mark as done" call
// site, so these two never drift from what really happened.
export async function markExecuted(tenantId: string, id: string): Promise<AgentApproval> {
  const db = getDb();
  const rows = await db
    .update(agentApprovals)
    .set({ status: "executed", updatedAt: new Date() })
    .where(and(eq(agentApprovals.id, id), eq(agentApprovals.tenantId, tenantId)))
    .returning();
  return assertOne(rows, "markExecuted");
}

// The failure reason itself is not written here — it already lives on the
// linked agent_runs row (via orchestrator.ts's completeRun), which is the
// one place a run's own error is recorded; overwriting agent_approvals'
// own `reason` column (the original "why this required approval") would
// destroy that information for no benefit. Join via agent_run_id to see
// both.
export async function markExecutionFailed(tenantId: string, id: string): Promise<AgentApproval> {
  const db = getDb();
  const rows = await db
    .update(agentApprovals)
    .set({ status: "execution_failed", updatedAt: new Date() })
    .where(and(eq(agentApprovals.id, id), eq(agentApprovals.tenantId, tenantId)))
    .returning();
  return assertOne(rows, "markExecutionFailed");
}
