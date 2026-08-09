import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  marketingConnections,
  marketingLinkedResources,
  findings,
  marketingHealthScores,
  reports,
  assertOne,
  type Finding,
} from "@bos/db";
import { encryptToken } from "./encryption";
import { computeHealthScore } from "./health-score";
import type { AddLinkedResourceInput, CreateFindingInput, ListFindingsInput } from "./schema";

export async function getConnectionStatus(tenantId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(marketingConnections)
    .where(eq(marketingConnections.tenantId, tenantId));

  if (!row) return { status: "none" as const };

  return {
    status: row.status,
    connectedAt: row.connectedAt,
    scopes: row.grantedScopes,
    lastVerifiedAt: row.lastVerifiedAt,
  };
}

export async function upsertConnection(
  tenantId: string,
  input: { refreshToken: string; scopes: string[]; connectedBy: string },
) {
  const db = getDb();
  const encryptedRefreshToken = encryptToken(input.refreshToken);

  const [existing] = await db
    .select()
    .from(marketingConnections)
    .where(eq(marketingConnections.tenantId, tenantId));

  if (existing) {
    const rows = await db
      .update(marketingConnections)
      .set({
        encryptedRefreshToken,
        grantedScopes: input.scopes,
        connectedBy: input.connectedBy,
        status: "active",
        connectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(marketingConnections.id, existing.id))
      .returning();
    return assertOne(rows, "upsertConnection (update)");
  }

  const rows = await db
    .insert(marketingConnections)
    .values({
      tenantId,
      encryptedRefreshToken,
      grantedScopes: input.scopes,
      connectedBy: input.connectedBy,
      status: "active",
    })
    .returning();
  return assertOne(rows, "upsertConnection (insert)");
}

export async function disconnectConnection(tenantId: string) {
  const db = getDb();
  const [row] = await db
    .update(marketingConnections)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(eq(marketingConnections.tenantId, tenantId))
    .returning();
  return row ?? null;
}

export async function listLinkedResources(tenantId: string) {
  const db = getDb();
  return db
    .select()
    .from(marketingLinkedResources)
    .where(eq(marketingLinkedResources.tenantId, tenantId));
}

export async function addLinkedResource(tenantId: string, input: AddLinkedResourceInput) {
  const db = getDb();
  const [connection] = await db
    .select()
    .from(marketingConnections)
    .where(eq(marketingConnections.tenantId, tenantId));

  if (!connection) {
    throw new Error("No Google connection exists for this tenant yet");
  }

  const rows = await db
    .insert(marketingLinkedResources)
    .values({ tenantId, connectionId: connection.id, ...input })
    .returning();
  return assertOne(rows, "addLinkedResource");
}

export async function removeLinkedResource(tenantId: string, id: string) {
  const db = getDb();
  const [row] = await db
    .delete(marketingLinkedResources)
    .where(and(eq(marketingLinkedResources.tenantId, tenantId), eq(marketingLinkedResources.id, id)))
    .returning();
  return row ?? null;
}

// ── Findings ──────────────────────────────────────────────────────────
// Called by run-check.ts's orchestrator for every new (non-duplicate)
// finding a check produces.

export async function createFinding(tenantId: string, input: CreateFindingInput) {
  const db = getDb();
  const rows = await db
    .insert(findings)
    .values({ tenantId, ...input })
    .returning();
  return assertOne(rows, "createFinding");
}

export async function listFindings(tenantId: string, input: ListFindingsInput) {
  const db = getDb();

  const where = and(
    eq(findings.tenantId, tenantId),
    input.status ? eq(findings.status, input.status) : undefined,
    input.severity ? eq(findings.severity, input.severity) : undefined,
    input.nature ? eq(findings.nature, input.nature) : undefined,
    input.category ? eq(findings.category, input.category) : undefined,
  );

  return db
    .select()
    .from(findings)
    .where(where)
    .orderBy(desc(findings.firstDetectedAt))
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize);
}

export async function getFinding(tenantId: string, id: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(findings)
    .where(and(eq(findings.tenantId, tenantId), eq(findings.id, id)));
  return row ?? null;
}

export async function updateFindingStatus(
  tenantId: string,
  id: string,
  status: Finding["status"],
) {
  const db = getDb();
  const [row] = await db
    .update(findings)
    .set({ status, resolvedAt: status === "resolved" ? new Date() : null, updatedAt: new Date() })
    .where(and(eq(findings.tenantId, tenantId), eq(findings.id, id)))
    .returning();
  return row ?? null;
}

async function listOpenFindings(tenantId: string) {
  const db = getDb();
  return db
    .select()
    .from(findings)
    .where(and(eq(findings.tenantId, tenantId), eq(findings.status, "open")));
}

// ── Health Score ──────────────────────────────────────────────────────

export async function getCurrentHealthScore(tenantId: string) {
  const db = getDb();
  const [latest] = await db
    .select()
    .from(marketingHealthScores)
    .where(eq(marketingHealthScores.tenantId, tenantId))
    .orderBy(desc(marketingHealthScores.computedAt))
    .limit(1);
  return latest ?? null;
}

export async function listHealthScoreHistory(tenantId: string, limit = 30) {
  const db = getDb();
  return db
    .select()
    .from(marketingHealthScores)
    .where(eq(marketingHealthScores.tenantId, tenantId))
    .orderBy(desc(marketingHealthScores.computedAt))
    .limit(limit);
}

// Recomputes from currently-open findings and stores a snapshot. Called by
// run-check.ts after every check run.
export async function recordHealthScoreSnapshot(tenantId: string, checkRunId?: string) {
  const db = getDb();
  const openFindings = await listOpenFindings(tenantId);
  const result = computeHealthScore(openFindings);

  const rows = await db
    .insert(marketingHealthScores)
    .values({
      tenantId,
      checkRunId,
      overallScore: result.overall,
      breakdown: result.breakdown,
      opportunityValue: result.opportunityValue,
    })
    .returning();
  return assertOne(rows, "recordHealthScoreSnapshot");
}

// ── Reports ───────────────────────────────────────────────────────────

export async function listReports(tenantId: string, limit = 20) {
  const db = getDb();
  return db
    .select()
    .from(reports)
    .where(eq(reports.tenantId, tenantId))
    .orderBy(desc(reports.generatedAt))
    .limit(limit);
}

export async function getReport(tenantId: string, id: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.tenantId, tenantId), eq(reports.id, id)));
  return row ?? null;
}
