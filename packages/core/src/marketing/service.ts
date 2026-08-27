import { and, desc, eq, isNull } from "drizzle-orm";
import {
  getDb,
  marketingConnections,
  marketingLinkedResources,
  findings,
  marketingHealthScores,
  marketingLeads,
  reports,
  clients,
  tenants,
  assertOne,
  type Finding,
} from "@bos/db";
import { encryptToken } from "./encryption";
import { computeHealthScore } from "./health-score";

import type {
  AddLinkedResourceInput,
  CreateFindingInput,
  ListFindingsInput,
  RecordLeadIntentInput,
  ListUnlinkedLeadsInput,
} from "./schema";

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

// ── Marketing leads (anonymous intent capture) ───────────────────────────
// See packages/db/src/schema/marketing.ts and the funnel design audit.

// Same pattern as clients/service.ts's private getDefaultTenantId — not
// imported from there (that function isn't exported, and importing another
// module's internals would violate ADR 0002's module-boundary rule anyway).
// recordLeadIntent is, like clients.submitLead, a public unauthenticated
// entry point with no session to read a tenantId from.
async function getDefaultTenantId(): Promise<string> {
  const db = getDb();
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, "bonolini-transfer"));
  if (!tenant) {
    throw new Error('Default tenant "bonolini-transfer" not found — was 0000_init.sql applied?');
  }
  return tenant.id;
}

// Public, unauthenticated entry point (the future lead-intent endpoint —
// see the funnel design audit). Input is intentionally narrow
// (recordLeadIntentSchema): no name/phone/email/notes, no clientId, no
// tenantId from the caller. Every new lead starts status "new" and
// clientId null — linking to a real client only ever happens through
// linkLeadToClient, by a staff member, never automatically here.
export async function recordLeadIntent(input: RecordLeadIntentInput) {
  const db = getDb();
  const tenantId = await getDefaultTenantId();

  const rows = await db
    .insert(marketingLeads)
    .values({
      tenantId,
      channel: input.channel,
      status: "new",
      clientId: null,
      landingPage: input.landingPage,
      referrer: input.referrer,
      utmSource: input.utmSource,
      utmMedium: input.utmMedium,
      utmCampaign: input.utmCampaign,
      utmTerm: input.utmTerm,
      utmContent: input.utmContent,
      gclid: input.gclid,
      visitorId: input.visitorId,
    })
    .returning();
  return assertOne(rows, "recordLeadIntent");
}

// Staff-only (caller must pass a tenantId sourced from an authenticated
// session — see the module's adminProcedure pattern in router.ts; this
// function does not and must not accept it from anywhere else). Every
// query is explicitly scoped by tenantId here rather than relying on RLS:
// this app's DATABASE_URL connects as a role that bypasses RLS (see the
// caveat in 0004_funnel_attribution.sql and 0006_marketing_leads.sql), so
// tenant isolation has to be real in the query, not assumed from a policy
// that isn't actually being enforced by this connection.
export async function listUnlinkedLeads(tenantId: string, input: ListUnlinkedLeadsInput) {
  const db = getDb();
  return db
    .select()
    .from(marketingLeads)
    .where(
      and(
        eq(marketingLeads.tenantId, tenantId),
        isNull(marketingLeads.clientId),
        input.channel ? eq(marketingLeads.channel, input.channel) : undefined,
      ),
    )
    .orderBy(desc(marketingLeads.createdAt))
    .limit(input.limit);
}

// Staff-only. Deliberately manual and narrow: no automatic matching by
// name/phone/email (neither is known at click time — see the funnel design
// audit), no client creation/mutation, no quote/booking side effects. Just
// the link + status transition. Returns null (not a thrown TRPCError —
// that's the router's job, same convention as updateFindingStatus/
// removeLinkedResource above) if the lead or the client don't both exist
// in the caller's own tenant.
export async function linkLeadToClient(
  tenantId: string,
  input: { marketingLeadId: string; clientId: string },
) {
  const db = getDb();

  const [lead] = await db
    .select({ id: marketingLeads.id })
    .from(marketingLeads)
    .where(and(eq(marketingLeads.tenantId, tenantId), eq(marketingLeads.id, input.marketingLeadId)));
  if (!lead) return null;

  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, input.clientId)));
  if (!client) return null;

  const rows = await db
    .update(marketingLeads)
    .set({ clientId: input.clientId, status: "converted" })
    .where(and(eq(marketingLeads.tenantId, tenantId), eq(marketingLeads.id, input.marketingLeadId)))
    .returning();
  return assertOne(rows, "linkLeadToClient");
}
