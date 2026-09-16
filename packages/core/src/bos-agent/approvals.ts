import { and, desc, eq } from "drizzle-orm";
import { getDb, agentApprovals, assertOne, type AgentApproval } from "@bos/db";
import type { RiskLevel } from "@bos/ai";

// Generalizes transfer-requests' pending_admin_approval -> ACCEPT/REJECT
// pattern (packages/core/src/transfer-requests/service.ts) into a single
// table any agent tool can use, instead of every module growing its own
// bespoke approval columns. Same idempotency discipline: approving an
// already-approved row (or rejecting an already-rejected one) is a safe
// no-op that returns the existing row, never a silent overwrite of a
// different outcome — approving an already-*rejected* row (or vice versa)
// is a real error.

export interface CreateApprovalInput {
  tenantId: string;
  agentRunId: string;
  requestedAction: string;
  risk: RiskLevel;
  reason: string;
  payload?: unknown;
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
  if (existing.status === "approved") {
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
