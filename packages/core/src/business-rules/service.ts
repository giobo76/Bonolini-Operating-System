import { and, desc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  businessRules,
  businessRuleVersions,
  businessRuleVersionEvidence,
  assertOne,
  type BusinessRule,
  type BusinessRuleVersion,
  type Evidence,
} from "@bos/db";
import { getEvidenceByIds } from "../evidence";
import type { CreateBusinessRuleInput, ProposeBusinessRuleVersionInput } from "./schema";

// BOS Business Intelligence + Autonomy Model, Phase 1 — the founder owns
// business rules exclusively (see this module's own README's "Governance"
// section). The state machine enforced below is the actual mechanism that
// makes that true in code, not just in policy:
//
//   proposed -> approved -> effective
//   proposed -> rejected
//   (the rule's previous "effective" version) -> superseded, only as a
//     side effect of a *different* version becoming "effective"
//
// No function in this file ever lets a caller set a version straight to
// "effective"/"superseded" on creation, and no function ever updates a
// version's `content`/`author`/`proposalReasoning` after insert — those
// three fields are write-once. The only functions that mutate a version
// after creation are approveBusinessRuleVersion/rejectBusinessRuleVersion,
// both of which validate the version's CURRENT status before touching it
// (see the inline transition guards), and both are the only functions
// business-rules/router.ts exposes as adminProcedure mutations — nothing
// in this module is reachable from a code path a BOS-agent tool could call
// that produces anything other than status="proposed".

async function getBusinessRuleRowForTenant(tenantId: string, id: string): Promise<BusinessRule | null> {
  const db = getDb();
  const [row] = await db.select().from(businessRules).where(and(eq(businessRules.tenantId, tenantId), eq(businessRules.id, id)));
  return row ?? null;
}

async function getVersionForTenant(tenantId: string, versionId: string): Promise<BusinessRuleVersion | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(businessRuleVersions)
    .where(and(eq(businessRuleVersions.tenantId, tenantId), eq(businessRuleVersions.id, versionId)));
  return row ?? null;
}

// The rule's very existence/key/category is a business decision — this is
// deliberately the only function that creates a business_rules row, and
// business-rules/router.ts gates it behind adminProcedure. A BOS-agent
// analysis can only ever propose a new *version* of an already-existing
// rule (proposeBusinessRuleVersion below), never invent a brand-new rule
// key unilaterally.
export async function createBusinessRule(tenantId: string, input: CreateBusinessRuleInput): Promise<BusinessRule> {
  const db = getDb();
  const rows = await db.insert(businessRules).values({ tenantId, key: input.key, category: input.category }).returning();
  return assertOne(rows, "createBusinessRule");
}

export async function listBusinessRules(tenantId: string): Promise<BusinessRule[]> {
  const db = getDb();
  return db.select().from(businessRules).where(eq(businessRules.tenantId, tenantId)).orderBy(desc(businessRules.updatedAt));
}

export interface BusinessRuleVersionWithEvidence extends BusinessRuleVersion {
  evidence: Evidence[];
}

export interface BusinessRuleDetail extends BusinessRule {
  versions: BusinessRuleVersionWithEvidence[];
}

// The DETTAGLIO view's one read: current rule row + full version history,
// each version carrying the real evidence rows it cites (not just ids) —
// this is what lets a recommendation be reconstructed end to end (rule
// content -> reasoning -> the actual observed facts behind it) in one
// call, per this phase's "provenance" requirement.
export async function getBusinessRule(tenantId: string, id: string): Promise<BusinessRuleDetail | null> {
  const db = getDb();
  const rule = await getBusinessRuleRowForTenant(tenantId, id);
  if (!rule) return null;

  const versions = await db
    .select()
    .from(businessRuleVersions)
    .where(and(eq(businessRuleVersions.tenantId, tenantId), eq(businessRuleVersions.ruleId, id)))
    .orderBy(desc(businessRuleVersions.versionNumber));

  if (versions.length === 0) {
    return { ...rule, versions: [] };
  }

  const versionIds = versions.map((v) => v.id);
  const links = await db
    .select()
    .from(businessRuleVersionEvidence)
    .where(and(eq(businessRuleVersionEvidence.tenantId, tenantId), inArray(businessRuleVersionEvidence.businessRuleVersionId, versionIds)));

  const evidenceRows = await getEvidenceByIds(tenantId, [...new Set(links.map((l) => l.evidenceId))]);
  const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));

  const evidenceByVersionId = new Map<string, Evidence[]>();
  for (const link of links) {
    const found = evidenceById.get(link.evidenceId);
    if (!found) continue; // stale/cross-tenant link id — never surfaced, never thrown
    const list = evidenceByVersionId.get(link.businessRuleVersionId) ?? [];
    list.push(found);
    evidenceByVersionId.set(link.businessRuleVersionId, list);
  }

  return {
    ...rule,
    versions: versions.map((version) => ({ ...version, evidence: evidenceByVersionId.get(version.id) ?? [] })),
  };
}

// The one function that creates a version — always status="proposed",
// regardless of `author`. There is no other exported function that could
// create a version at any other status; approve/reject (below) are the
// only way a "proposed" row ever moves. `evidenceIds` are validated
// (tenant-scoped, real rows only) and silently filtered rather than
// throwing on a stray id — a proposal must never fail to save just because
// one citation was stale.
export async function proposeBusinessRuleVersion(
  tenantId: string,
  input: ProposeBusinessRuleVersionInput,
): Promise<BusinessRuleVersion> {
  const db = getDb();
  const rule = await getBusinessRuleRowForTenant(tenantId, input.ruleId);
  if (!rule) {
    throw new Error(`proposeBusinessRuleVersion: rule ${input.ruleId} not found for this tenant`);
  }

  const [lastVersion] = await db
    .select({ versionNumber: businessRuleVersions.versionNumber })
    .from(businessRuleVersions)
    .where(and(eq(businessRuleVersions.tenantId, tenantId), eq(businessRuleVersions.ruleId, input.ruleId)))
    .orderBy(desc(businessRuleVersions.versionNumber))
    .limit(1);
  const nextVersionNumber = (lastVersion?.versionNumber ?? 0) + 1;

  const rows = await db
    .insert(businessRuleVersions)
    .values({
      tenantId,
      ruleId: input.ruleId,
      versionNumber: nextVersionNumber,
      status: "proposed",
      content: input.content,
      author: input.author,
      proposalReasoning: input.proposalReasoning ?? null,
    })
    .returning();
  const version = assertOne(rows, "proposeBusinessRuleVersion");

  if (input.evidenceIds.length > 0) {
    const validEvidence = await getEvidenceByIds(tenantId, input.evidenceIds);
    if (validEvidence.length > 0) {
      await db
        .insert(businessRuleVersionEvidence)
        .values(validEvidence.map((ev) => ({ tenantId, businessRuleVersionId: version.id, evidenceId: ev.id })));
    }
  }

  return version;
}

// Attaches one more piece of evidence to an existing proposal — only while
// it's still "proposed". Once decided (approved/rejected/effective/
// superseded), a version's evidence set is frozen exactly like its content
// is: immutable, so "which facts supported this decision" can never
// silently change after the fact.
export async function linkEvidenceToVersion(tenantId: string, versionId: string, evidenceId: string): Promise<void> {
  const version = await getVersionForTenant(tenantId, versionId);
  if (!version) {
    throw new Error(`linkEvidenceToVersion: version ${versionId} not found for this tenant`);
  }
  if (version.status !== "proposed") {
    throw new Error(
      `linkEvidenceToVersion: cannot attach evidence to a version with status '${version.status}' — a decided version is immutable`,
    );
  }

  const [ev] = await getEvidenceByIds(tenantId, [evidenceId]);
  if (!ev) {
    throw new Error(`linkEvidenceToVersion: evidence ${evidenceId} not found for this tenant`);
  }

  const db = getDb();
  await db
    .insert(businessRuleVersionEvidence)
    .values({ tenantId, businessRuleVersionId: versionId, evidenceId })
    .onConflictDoNothing();
}

// Owner-only (enforced by router.ts's adminProcedure, never by this
// function itself — the function's own job is just the state machine).
// Performs BOTH proposed->approved and approved->effective in one call:
// Phase 1 has no UI/requirement for scheduling a delayed activation, so
// there is no reason to make the founder call two separate mutations for
// one decision. The two transitions are still validated as genuinely
// separate steps internally (see the two guarded branches below), so a
// later phase could split them into two calls without redesigning this
// function.
//
// Idempotent: calling this again on a version this exact flow already
// made "effective" returns it unchanged — never re-supersedes, never
// re-stamps decidedAt. Calling it on "rejected"/"superseded" throws: those
// are terminal, conflicting decisions, never silently overridden.
export async function approveBusinessRuleVersion(
  tenantId: string,
  versionId: string,
  decidedByProfileId: string,
  reasoning?: string,
): Promise<BusinessRuleVersion> {
  const version = await getVersionForTenant(tenantId, versionId);
  if (!version) {
    throw new Error(`approveBusinessRuleVersion: version ${versionId} not found for this tenant`);
  }
  if (version.status === "effective") {
    return version;
  }
  if (version.status !== "proposed" && version.status !== "approved") {
    throw new Error(`approveBusinessRuleVersion: cannot approve a version with status '${version.status}'`);
  }

  const db = getDb();
  const now = new Date();

  if (version.status === "proposed") {
    await db
      .update(businessRuleVersions)
      .set({
        status: "approved",
        ownerDecision: "approved",
        ownerDecisionReason: reasoning ?? null,
        decidedBy: decidedByProfileId,
        decidedAt: now,
      })
      .where(and(eq(businessRuleVersions.tenantId, tenantId), eq(businessRuleVersions.id, versionId)));
  }

  const rule = await getBusinessRuleRowForTenant(tenantId, version.ruleId);
  if (!rule) {
    throw new Error(`approveBusinessRuleVersion: rule ${version.ruleId} not found for this tenant`);
  }

  // The rule's previous current version (if any) becomes superseded —
  // exactly and only because this new one is about to become effective.
  // Guarded on status="effective" so this is a no-op if that previous
  // version were, for any reason, already no longer effective.
  if (rule.currentVersionId) {
    await db
      .update(businessRuleVersions)
      .set({ status: "superseded" })
      .where(
        and(
          eq(businessRuleVersions.tenantId, tenantId),
          eq(businessRuleVersions.id, rule.currentVersionId),
          eq(businessRuleVersions.status, "effective"),
        ),
      );
  }

  const updatedRows = await db
    .update(businessRuleVersions)
    .set({ status: "effective", effectiveFrom: now })
    .where(and(eq(businessRuleVersions.tenantId, tenantId), eq(businessRuleVersions.id, versionId)))
    .returning();

  await db
    .update(businessRules)
    .set({ currentVersionId: versionId, updatedAt: now })
    .where(and(eq(businessRules.tenantId, tenantId), eq(businessRules.id, rule.id)));

  return assertOne(updatedRows, "approveBusinessRuleVersion");
}

// Owner-only (enforced by router.ts). `reasoning` is required at the
// schema layer (rejectBusinessRuleVersionSchema) — a rejection without a
// stated reason gives the BOS nothing to learn from for a future
// proposal, per this phase's own "conservare la motivazione del titolare"
// requirement. Idempotent on an already-rejected version; throws on
// anything else already decided (approved/effective/superseded) — a
// version that already went the other way is never silently flipped.
export async function rejectBusinessRuleVersion(
  tenantId: string,
  versionId: string,
  decidedByProfileId: string,
  reasoning: string,
): Promise<BusinessRuleVersion> {
  const version = await getVersionForTenant(tenantId, versionId);
  if (!version) {
    throw new Error(`rejectBusinessRuleVersion: version ${versionId} not found for this tenant`);
  }
  if (version.status === "rejected") {
    return version;
  }
  if (version.status !== "proposed") {
    throw new Error(`rejectBusinessRuleVersion: cannot reject a version with status '${version.status}'`);
  }

  const db = getDb();
  const now = new Date();
  const rows = await db
    .update(businessRuleVersions)
    .set({
      status: "rejected",
      ownerDecision: "rejected",
      ownerDecisionReason: reasoning,
      decidedBy: decidedByProfileId,
      decidedAt: now,
    })
    .where(and(eq(businessRuleVersions.tenantId, tenantId), eq(businessRuleVersions.id, versionId)))
    .returning();

  return assertOne(rows, "rejectBusinessRuleVersion");
}
