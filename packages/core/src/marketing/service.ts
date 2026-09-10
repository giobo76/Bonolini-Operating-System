import { and, desc, eq, isNull, ne } from "drizzle-orm";
import {
  getDb,
  marketingConnections,
  marketingLinkedResources,
  findings,
  marketingHealthScores,
  marketingLeads,
  leadMatchCandidates,
  whatsappMessages,
  reports,
  clients,
  tenants,
  assertOne,
  type Finding,
  type Client,
  type MarketingLead,
} from "@bos/db";
import { encryptToken } from "./encryption";
import { computeHealthScore } from "./health-score";
import { generateContactToken, extractContactToken } from "./contact-token";
import { findTimeProximityCandidates } from "./lead-matching";
import { log, captureException } from "../observability";

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

  // Without this, the Health Score badge on /marketing stays stale after a
  // manual Mark resolved/Dismiss until the next scheduled check_run (up to
  // 4h away on quick_check's cadence) — a resolved finding would keep
  // dragging the score down even though the page shows it as no longer
  // open. checkRunId is intentionally omitted: this snapshot wasn't
  // produced by a check run, it's a direct consequence of a manual action.
  if (row) {
    await recordHealthScoreSnapshot(tenantId);
  }

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
// 5 consecutive collisions against ~40 bits of entropy each is
// astronomically unlikely — this loop exists for defense-in-depth, not
// because a real collision is expected.
const MAX_CONTACT_TOKEN_ATTEMPTS = 5;

async function generateUniqueContactToken(tenantId: string): Promise<string | null> {
  const db = getDb();
  for (let attempt = 0; attempt < MAX_CONTACT_TOKEN_ATTEMPTS; attempt++) {
    const candidate = generateContactToken();
    const existing = await db
      .select({ id: marketingLeads.id })
      .from(marketingLeads)
      .where(and(eq(marketingLeads.tenantId, tenantId), eq(marketingLeads.contactToken, candidate)));
    if (existing.length === 0) return candidate;
  }
  return null;
}

export async function recordLeadIntent(input: RecordLeadIntentInput) {
  const db = getDb();
  const tenantId = await getDefaultTenantId();

  // Only whatsapp/email can carry a token back to BOS in the actual reply
  // text — a phone call and a form submission have no equivalent "reply"
  // BOS ever reads, so generating one for them would be dead weight. See
  // marketing/contact-token.ts.
  let contactToken: string | null = null;
  if (input.channel === "whatsapp" || input.channel === "email") {
    try {
      contactToken = await generateUniqueContactToken(tenantId);
    } catch (error) {
      // Fail soft: a DB hiccup while minting a token must never block
      // recording the lead itself, or the visitor's real contact attempt
      // that depends on this call returning promptly.
      captureException(error, "marketing.lead_intent.token_generation_failed", { channel: input.channel });
      contactToken = null;
    }
  }

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
      contactToken,
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
//
// An explicit human confirmation is one of exactly three things that ever
// produce attribution_confidence='certain' (the other two: a matched
// contact_token, a matched visitor_id — see confirmLeadByContactToken
// below). This function NEVER writes to `clients` — acquisition
// attribution is write-once, set only at the moment a client is first
// created, never touched by any later lead-linking activity. Linking a
// 2026-09 ChatGPT-sourced lead to a client who was actually acquired via
// Google Ads in 2026-08 must never make it look like ChatGPT acquired
// them — this function structurally cannot do that, since it has no code
// path that writes a client column at all.
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
    .set({
      clientId: input.clientId,
      status: "converted",
      attributionConfidence: "certain",
      attributionMethod: "manual_admin",
    })
    .where(and(eq(marketingLeads.tenantId, tenantId), eq(marketingLeads.id, input.marketingLeadId)))
    .returning();
  return assertOne(rows, "linkLeadToClient");
}

// ── Deterministic reconciliation via contact_token ───────────────────────
// Called from the whatsapp module (packages/core/src/whatsapp/service.ts,
// a legitimate cross-module call through this module's public boundary —
// same pattern calendar already uses to reach ../marketing) once an
// inbound message's client has been resolved. Never called for a message
// whose text carries no recognizable token — extractContactToken returns
// null immediately, no DB round-trip wasted.
//
// Acquisition write-once, enforced here structurally: `clientIsNew` must
// be true (this client row was created in this exact call, not found by
// phone) before this function ever touches a `clients` column. A returning
// customer's contact_token match still links the lead (so lead-based
// funnel reporting works), but their existing acquisition fields are never
// touched — they were acquired whenever they first showed up, not now.
export interface ConfirmLeadByContactTokenResult {
  linked: boolean;
  marketingLeadId?: string;
}

async function backfillClientAcquisitionFromLead(client: Client, lead: MarketingLead): Promise<void> {
  const updates: Partial<Client> = {};
  if (!client.utmSource && lead.utmSource) updates.utmSource = lead.utmSource;
  if (!client.utmMedium && lead.utmMedium) updates.utmMedium = lead.utmMedium;
  if (!client.utmCampaign && lead.utmCampaign) updates.utmCampaign = lead.utmCampaign;
  if (!client.utmTerm && lead.utmTerm) updates.utmTerm = lead.utmTerm;
  if (!client.utmContent && lead.utmContent) updates.utmContent = lead.utmContent;
  if (!client.gclid && lead.gclid) updates.gclid = lead.gclid;
  if (!client.landingPage && lead.landingPage) updates.landingPage = lead.landingPage;
  if (!client.referrer && lead.referrer) updates.referrer = lead.referrer;

  if (Object.keys(updates).length === 0) return;

  const db = getDb();
  await db.update(clients).set(updates).where(eq(clients.id, client.id));
}

export async function confirmLeadByContactToken(
  tenantId: string,
  input: { rawText: string; client: Client; clientIsNew: boolean },
): Promise<ConfirmLeadByContactTokenResult> {
  const token = extractContactToken(input.rawText);
  if (!token) return { linked: false };

  const db = getDb();

  // Only an unlinked lead is eligible — a token string reappearing after
  // its lead is already resolved (e.g. a customer replies twice) must
  // never re-target or duplicate a link.
  const [lead] = await db
    .select()
    .from(marketingLeads)
    .where(
      and(
        eq(marketingLeads.tenantId, tenantId),
        eq(marketingLeads.contactToken, token),
        isNull(marketingLeads.clientId),
      ),
    );
  if (!lead) return { linked: false };

  await db
    .update(marketingLeads)
    .set({
      clientId: input.client.id,
      status: "converted",
      attributionConfidence: "certain",
      attributionMethod: "contact_token",
    })
    .where(eq(marketingLeads.id, lead.id));

  if (input.clientIsNew) {
    await backfillClientAcquisitionFromLead(input.client, lead);
  }

  log("marketing.lead_intent.confirmed_by_token", {
    tenantId,
    marketingLeadId: lead.id,
    clientIsNew: input.clientIsNew,
  });

  return { linked: true, marketingLeadId: lead.id };
}

// ── Ambiguous candidate detection (time-proximity only) ──────────────────
// Manually triggered (via marketing.detectAmbiguousLeadCandidates,
// adminProcedure) — no cron wires this up yet, a deliberate scope
// decision, not an oversight. Idempotent: re-running never duplicates a
// candidate row (unique on marketing_lead_id+client_id) and never
// downgrades a lead that became "certain" in the meantime.
export interface RecordAmbiguousLeadCandidatesResult {
  candidatesRecorded: number;
  leadsMarkedAmbiguous: number;
}

export async function recordAmbiguousLeadCandidates(tenantId: string): Promise<RecordAmbiguousLeadCandidatesResult> {
  const db = getDb();

  const [candidateLeads, messages] = await Promise.all([
    db
      .select()
      .from(marketingLeads)
      .where(
        and(
          eq(marketingLeads.tenantId, tenantId),
          isNull(marketingLeads.clientId),
          ne(marketingLeads.attributionConfidence, "certain"),
        ),
      ),
    db
      .select({ clientId: whatsappMessages.clientId, receivedAt: whatsappMessages.receivedAt })
      .from(whatsappMessages)
      .where(and(eq(whatsappMessages.tenantId, tenantId))),
  ]);

  const pairs = findTimeProximityCandidates(candidateLeads, messages);

  let candidatesRecorded = 0;
  const leadsToMarkAmbiguous = new Set<string>();

  for (const pair of pairs) {
    const inserted = await db
      .insert(leadMatchCandidates)
      .values({
        tenantId,
        marketingLeadId: pair.marketingLeadId,
        clientId: pair.clientId,
        method: "whatsapp_time_proximity",
        note: `${pair.deltaMinutes.toFixed(1)} min after lead creation`,
      })
      .onConflictDoNothing({ target: [leadMatchCandidates.marketingLeadId, leadMatchCandidates.clientId] })
      .returning();
    if (inserted.length > 0) candidatesRecorded += 1;
    leadsToMarkAmbiguous.add(pair.marketingLeadId);
  }

  let leadsMarkedAmbiguous = 0;
  for (const leadId of leadsToMarkAmbiguous) {
    const updated = await db
      .update(marketingLeads)
      .set({ attributionConfidence: "ambiguous" })
      .where(
        and(
          eq(marketingLeads.id, leadId),
          eq(marketingLeads.tenantId, tenantId),
          eq(marketingLeads.attributionConfidence, "unknown"),
        ),
      )
      .returning({ id: marketingLeads.id });
    if (updated.length > 0) leadsMarkedAmbiguous += 1;
  }

  return { candidatesRecorded, leadsMarkedAmbiguous };
}

export async function listLeadMatchCandidates(tenantId: string) {
  const db = getDb();
  return db
    .select()
    .from(leadMatchCandidates)
    .where(eq(leadMatchCandidates.tenantId, tenantId))
    .orderBy(desc(leadMatchCandidates.createdAt));
}
