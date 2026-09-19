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
import type { CreateBusinessRuleInput, ProposeBusinessRuleVersionInput, ProposeNewBusinessRuleInput } from "./schema";

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
//
// Governance revision: the BOS can now also propose an entirely new rule
// (proposeNewBusinessRule), not only a new version of one that already
// exists — a `business_rules` row's mere existence has never been what
// makes it "official" in this design: only `current_version_id` being set
// does, and that only ever happens via approveBusinessRuleVersion. So a
// BOS-created rule shell with no approved version yet is exactly as
// non-authoritative as a BOS-proposed version of an existing rule — the
// same governance guarantee, extended to cover the rule's own creation,
// not a new exception to it. createBusinessRule (founder-only, via
// router.ts's adminProcedure) remains for the founder's own direct use.

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

// The founder's own direct way to register a rule key — business-
// rules/router.ts gates it behind adminProcedure. proposeNewBusinessRule
// (below) is the BOS-agent equivalent: it also creates a business_rules
// row, but always paired with a status="proposed" version in the same
// call, and the row it creates is exactly as non-authoritative as this
// one is on its own (no current_version_id) until the founder approves.
export async function createBusinessRule(tenantId: string, input: CreateBusinessRuleInput): Promise<BusinessRule> {
  const db = getDb();
  const rows = await db.insert(businessRules).values({ tenantId, key: input.key, category: input.category }).returning();
  return assertOne(rows, "createBusinessRule");
}

async function getBusinessRuleRowByKeyForTenant(tenantId: string, key: string): Promise<BusinessRule | null> {
  const db = getDb();
  const [row] = await db.select().from(businessRules).where(and(eq(businessRules.tenantId, tenantId), eq(businessRules.key, key)));
  return row ?? null;
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

async function assembleBusinessRuleDetail(tenantId: string, rule: BusinessRule): Promise<BusinessRuleDetail> {
  const db = getDb();
  const versions = await db
    .select()
    .from(businessRuleVersions)
    .where(and(eq(businessRuleVersions.tenantId, tenantId), eq(businessRuleVersions.ruleId, rule.id)))
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

// The DETTAGLIO view's one read: current rule row + full version history,
// each version carrying the real evidence rows it cites (not just ids) —
// this is what lets a recommendation be reconstructed end to end (rule
// content -> reasoning -> the actual observed facts behind it) in one
// call, per this phase's "provenance" requirement.
export async function getBusinessRule(tenantId: string, id: string): Promise<BusinessRuleDetail | null> {
  const rule = await getBusinessRuleRowForTenant(tenantId, id);
  if (!rule) return null;
  return assembleBusinessRuleDetail(tenantId, rule);
}

// The read a *consumer* of a rule (e.g. pricing's rates-provider.ts) uses —
// consumers know a rule's stable `key` (e.g. "pricing.minimum_fare"), never
// its generated id, which only the admin UI/router ever handles. Same
// shape as getBusinessRule, just keyed differently.
export async function getBusinessRuleByKey(tenantId: string, key: string): Promise<BusinessRuleDetail | null> {
  const rule = await getBusinessRuleRowByKeyForTenant(tenantId, key);
  if (!rule) return null;
  return assembleBusinessRuleDetail(tenantId, rule);
}

// Shared by proposeBusinessRuleVersion and proposeNewBusinessRule — the
// one place a business_rule_versions row is ever inserted, always
// status="proposed" regardless of `author`. There is no other function
// that could create a version at any other status; approve/reject
// (below) are the only way a "proposed" row ever moves. `evidenceIds` are
// validated (tenant-scoped, real rows only) and silently filtered rather
// than throwing on a stray id — a proposal must never fail to save just
// because one citation was stale.
async function insertProposedVersion(
  tenantId: string,
  ruleId: string,
  versionNumber: number,
  input: { content: Record<string, unknown>; author: "owner" | "bos_agent"; proposalReasoning?: string; evidenceIds: string[] },
): Promise<BusinessRuleVersion> {
  const db = getDb();
  const rows = await db
    .insert(businessRuleVersions)
    .values({
      tenantId,
      ruleId,
      versionNumber,
      status: "proposed",
      content: input.content,
      author: input.author,
      proposalReasoning: input.proposalReasoning ?? null,
    })
    .returning();
  const version = assertOne(rows, "insertProposedVersion");

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

  return insertProposedVersion(tenantId, input.ruleId, nextVersionNumber, input);
}

export interface NewBusinessRuleProposal {
  rule: BusinessRule;
  version: BusinessRuleVersion;
}

// The governance-revision entry point: the BOS can propose an opportunity
// that fits no existing rule key at all. Creates the business_rules row
// AND its first version (versionNumber=1, status="proposed") together —
// never a rule left with zero versions on success. Sequential, not
// wrapped in a db.transaction() (this codebase deliberately doesn't use
// one anywhere — see transfer-requests/service.ts's own "Opzione A"
// comment for the precedent this follows): if the version insert were to
// fail after the rule insert already committed, the rule is left with
// current_version_id still null — a recoverable, harmless, detectable
// state (a rule with no proposed version is not authoritative and not
// dangerous), not a silent inconsistency. A retry can simply call
// proposeBusinessRuleVersion against that now-existing rule id.
//
// Refuses to create a second rule under a key that already exists for
// this tenant (the unique(tenant_id, key) constraint would reject it
// anyway; checked here first for a clear error naming the real cause) —
// the caller should use proposeBusinessRuleVersion against the existing
// rule's id instead.
export async function proposeNewBusinessRule(
  tenantId: string,
  input: ProposeNewBusinessRuleInput,
): Promise<NewBusinessRuleProposal> {
  const existing = await getBusinessRuleRowByKeyForTenant(tenantId, input.key);
  if (existing) {
    throw new Error(
      `proposeNewBusinessRule: a rule with key '${input.key}' already exists for this tenant — propose a new version of rule ${existing.id} instead`,
    );
  }

  const db = getDb();
  const ruleRows = await db.insert(businessRules).values({ tenantId, key: input.key, category: input.category }).returning();
  const rule = assertOne(ruleRows, "proposeNewBusinessRule");

  const version = await insertProposedVersion(tenantId, rule.id, 1, input);

  return { rule, version };
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
