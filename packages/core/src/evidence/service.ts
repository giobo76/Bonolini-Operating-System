import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, evidence, assertOne, type Evidence } from "@bos/db";
import type { CreateEvidenceInput } from "./schema";

// Generalized evidence/provenance store (BOS Business Intelligence +
// Autonomy Model, Phase 1) — deliberately not specific to any one domain.
// Callers (business-rules/service.ts today; a future Ads/GA4/SEO or
// pricing-anomaly analysis tomorrow) create a row here for each observed
// fact/calculation/hypothesis/recommendation, then link it to wherever
// their own conclusion lives — see business-rules/service.ts's
// linkEvidenceToVersion. This module owns no notion of "which proposal
// this supports"; that link belongs to the consuming module.

export async function createEvidence(tenantId: string, input: CreateEvidenceInput): Promise<Evidence> {
  const db = getDb();
  const rows = await db
    .insert(evidence)
    .values({
      tenantId,
      collectedAt: input.collectedAt,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      source: input.source,
      queryOrCall: input.queryOrCall,
      rawObservation: input.rawObservation,
      calculation: input.calculation,
      conclusion: input.conclusion,
      evidenceType: input.evidenceType,
      confidence: input.confidence,
    })
    .returning();
  return assertOne(rows, "createEvidence");
}

export async function getEvidence(tenantId: string, id: string): Promise<Evidence | null> {
  const db = getDb();
  const [row] = await db.select().from(evidence).where(and(eq(evidence.tenantId, tenantId), eq(evidence.id, id)));
  return row ?? null;
}

// Bounded, newest-first — same discipline as every other unfiltered list
// read in this codebase (e.g. bos-agent/audit.ts's listRuns): never an
// unbounded table scan exposed to a caller.
const MAX_LIST_LIMIT = 50;

export async function listEvidence(tenantId: string, limit = 20): Promise<Evidence[]> {
  const db = getDb();
  return db
    .select()
    .from(evidence)
    .where(eq(evidence.tenantId, tenantId))
    .orderBy(desc(evidence.collectedAt))
    .limit(Math.min(limit, MAX_LIST_LIMIT));
}

// Fetches many by id in one round trip, scoped to the tenant — used by
// business-rules/service.ts to assemble the full evidence list for a
// version without an N+1 query per linked evidence id. Silently drops any
// id that doesn't exist or belongs to a different tenant, rather than
// throwing — a stale/cross-tenant id in a join table should never be able
// to leak another tenant's evidence row, and should never crash a read.
export async function getEvidenceByIds(tenantId: string, ids: string[]): Promise<Evidence[]> {
  if (ids.length === 0) return [];
  const db = getDb();
  return db
    .select()
    .from(evidence)
    .where(and(eq(evidence.tenantId, tenantId), inArray(evidence.id, ids)));
}
