import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, communications, assertOne, type Communication } from "@bos/db";
import { evaluatePolicy } from "@bos/ai";
import { getClient } from "../clients";
import { getQuote } from "../quotes";
import { getDeal } from "../deals";
import { getConfiguredOutboundProvider, type OutboundProvider } from "./provider";
import { buildQuoteOfferContent } from "./content";
import type { PrepareQuoteOfferCommunicationInput } from "./schema";

// The tool name recorded against @bos/ai's Policy Engine for every
// communication this module prepares — a stable identity for
// evaluatePolicy/audit, not a real bos-agent ToolRegistry entry (see
// bos-agent/tools/communication-tools.ts for the thin wrapper that IS
// registered there, for a future agent to propose through the full
// orchestrator loop).
const POLICY_TOOL_NAME = "communication.send_customer_message";

export async function getCommunication(tenantId: string, id: string): Promise<Communication | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(communications)
    .where(and(eq(communications.tenantId, tenantId), eq(communications.id, id)));
  return row ?? null;
}

export async function findCommunicationByIdempotencyKey(
  tenantId: string,
  idempotencyKey: string,
): Promise<Communication | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(communications)
    .where(and(eq(communications.tenantId, tenantId), eq(communications.idempotencyKey, idempotencyKey)))
    .orderBy(desc(communications.createdAt));
  return row ?? null;
}

export async function listCommunicationsForDeal(tenantId: string, dealId: string): Promise<Communication[]> {
  const db = getDb();
  return db
    .select()
    .from(communications)
    .where(and(eq(communications.tenantId, tenantId), eq(communications.dealId, dealId)))
    .orderBy(desc(communications.createdAt));
}

// PREPARE — builds real, deterministic content from an already-persisted
// deal/quote/client (never invents a price/availability/client fact — see
// content.ts) and persists it at status "prepared". No policy check, no
// approval, no send: this alone can never reach a customer. Idempotent at
// the DB level via a real UNIQUE(tenant_id, idempotency_key) constraint
// (raw INSERT ... ON CONFLICT, same pattern deals/transfer-requests'
// own create-or-find writes use) — a retry with the same quote never
// creates a second row.
export async function prepareQuoteOfferCommunication(
  input: PrepareQuoteOfferCommunicationInput,
): Promise<Communication> {
  const deal = await getDeal(input.tenantId, input.dealId);
  if (!deal) {
    throw new Error(`prepareQuoteOfferCommunication: no deal found for id ${input.dealId}`);
  }

  const quote = await getQuote(input.tenantId, input.quoteId);
  if (!quote) {
    throw new Error(`prepareQuoteOfferCommunication: no quote found for id ${input.quoteId}`);
  }
  if (quote.dealId !== input.dealId) {
    // Never trust the caller's dealId/quoteId pairing without verifying it
    // against the real, persisted link — see deals/README.md's "Quotes"
    // section for how a quote is linked to a deal (transfer-requests'
    // ACCEPT/MODIFY_PRICE).
    throw new Error(
      `prepareQuoteOfferCommunication: quote ${input.quoteId} does not belong to deal ${input.dealId} (belongs to ${quote.dealId ?? "no deal"})`,
    );
  }

  const client = await getClient(input.tenantId, input.clientId);
  if (!client) {
    throw new Error(`prepareQuoteOfferCommunication: no client found for id ${input.clientId}`);
  }
  if (quote.clientId !== input.clientId) {
    throw new Error(`prepareQuoteOfferCommunication: quote ${input.quoteId} does not belong to client ${input.clientId}`);
  }

  const content = buildQuoteOfferContent(client, quote);
  const idempotencyKey = `quote_offer:${quote.id}`;

  const db = getDb();
  const insertedRows = await db.execute<Communication>(sql`
    insert into communications (
      tenant_id, client_id, deal_id, transfer_request_id, quote_id, booking_id,
      channel, action, agent, correlation_id, idempotency_key, content, status
    ) values (
      ${input.tenantId}, ${input.clientId}, ${input.dealId}, ${null}, ${input.quoteId}, ${null},
      ${input.channel}, ${"quote_offer"}, ${input.agent}, ${input.correlationId ?? null}, ${idempotencyKey},
      ${JSON.stringify(content)}::jsonb, 'prepared'
    )
    on conflict (tenant_id, idempotency_key) do nothing
    returning *
  `);

  if (insertedRows.length > 0) {
    return assertOne(insertedRows, "prepareQuoteOfferCommunication");
  }

  const existing = await findCommunicationByIdempotencyKey(input.tenantId, idempotencyKey);
  if (!existing) {
    // Unreachable in practice: a conflict on this index means a matching
    // row exists. Guarded rather than silently swallowed, same discipline
    // as insertNewTransferRequest's/createDeal's equivalent branch.
    throw new Error("prepareQuoteOfferCommunication: insert conflicted but no existing communication was found");
  }
  return existing;
}

// POLICY CHECK + (if required) transition to pending_approval. Every
// communication this module can prepare is category "customer_communication",
// which @bos/ai's evaluatePolicy always marks requiresApproval — see
// policy.ts's ALWAYS_REQUIRES_APPROVAL. The policy decision is persisted
// verbatim, so an approver always sees the exact reasoning that gated
// this specific message, not a re-derived one. Idempotent: calling this
// again on an already-submitted (or later) row is a safe no-op.
export async function submitCommunicationForApproval(tenantId: string, id: string): Promise<Communication> {
  const db = getDb();
  const existing = await getCommunication(tenantId, id);
  if (!existing) {
    throw new Error(`submitCommunicationForApproval: no communication found for id ${id}`);
  }
  if (existing.status !== "prepared") {
    return existing;
  }

  const policyDecision = evaluatePolicy({
    toolName: POLICY_TOOL_NAME,
    category: "customer_communication",
    riskLevel: "requires_approval",
    requiresApproval: true,
    reversible: false,
  });

  const nextStatus = policyDecision.allowed ? "pending_approval" : "rejected";

  const rows = await db
    .update(communications)
    .set({ status: nextStatus, policyDecision, updatedAt: new Date() })
    .where(and(eq(communications.tenantId, tenantId), eq(communications.id, id)))
    .returning();
  return assertOne(rows, "submitCommunicationForApproval");
}

export async function approveCommunication(
  tenantId: string,
  id: string,
  approvedByProfileId: string,
): Promise<Communication> {
  const db = getDb();
  const existing = await getCommunication(tenantId, id);
  if (!existing) {
    throw new Error(`approveCommunication: no communication found for id ${id}`);
  }
  if (existing.status === "approved" || existing.status === "executed" || existing.status === "verified" || existing.status === "execution_failed") {
    return existing;
  }
  if (existing.status !== "pending_approval") {
    throw new Error(`approveCommunication: communication ${id} is '${existing.status}', not 'pending_approval'`);
  }

  const rows = await db
    .update(communications)
    .set({ status: "approved", approvedBy: approvedByProfileId, approvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(communications.tenantId, tenantId), eq(communications.id, id)))
    .returning();
  return assertOne(rows, "approveCommunication");
}

export async function rejectCommunication(tenantId: string, id: string): Promise<Communication> {
  const db = getDb();
  const existing = await getCommunication(tenantId, id);
  if (!existing) {
    throw new Error(`rejectCommunication: no communication found for id ${id}`);
  }
  if (existing.status === "rejected") {
    return existing;
  }
  if (existing.status !== "pending_approval") {
    throw new Error(`rejectCommunication: communication ${id} is '${existing.status}', not 'pending_approval'`);
  }

  const rows = await db
    .update(communications)
    .set({ status: "rejected", rejectedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(communications.tenantId, tenantId), eq(communications.id, id)))
    .returning();
  return assertOne(rows, "rejectCommunication");
}

// EXECUTE + VERIFY — the only function that ever calls an OutboundProvider.
// Reachable only from "approved" (never from "prepared"/"pending_approval"/
// "rejected" — see the throw below): this is the enforcement point for the
// founder's rule that nothing is ever sent before approval. Idempotent:
// already-terminal statuses (executed/verified/execution_failed) return
// the existing row unchanged and never call the provider a second time —
// an Inngest/orchestrator retry can never double-send.
//
// provider defaults to getConfiguredOutboundProvider() (today always
// NotConfiguredOutboundProvider — see provider.ts) but is injectable so a
// test can exercise the executed/verified path without a real provider
// existing, same pattern bos-agent/tools/social-tools.ts's
// createPrepareSocialContentTool(imageGenerator) already uses.
export async function executeCommunication(
  tenantId: string,
  id: string,
  provider: OutboundProvider = getConfiguredOutboundProvider(),
): Promise<Communication> {
  const db = getDb();
  const existing = await getCommunication(tenantId, id);
  if (!existing) {
    throw new Error(`executeCommunication: no communication found for id ${id}`);
  }

  if (existing.status === "executed" || existing.status === "verified" || existing.status === "execution_failed") {
    return existing;
  }
  if (existing.status !== "approved") {
    throw new Error(
      `executeCommunication: communication ${id} is '${existing.status}', not 'approved' — refusing to send an unapproved communication`,
    );
  }

  const content = existing.content as { to: string; body: string };

  let result: Awaited<ReturnType<OutboundProvider["send"]>>;
  try {
    result = await provider.send({
      channel: existing.channel,
      to: content.to,
      body: content.body,
      idempotencyKey: existing.idempotencyKey,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rows = await db
      .update(communications)
      .set({ status: "execution_failed", provider: provider.name, error: message, updatedAt: new Date() })
      .where(and(eq(communications.tenantId, tenantId), eq(communications.id, id)))
      .returning();
    return assertOne(rows, "executeCommunication");
  }

  if (result.status === "not_configured") {
    // NEVER a false success (rule 6/7 of the approved spec) — an
    // unconfigured provider is a real, explicit execution failure, not a
    // silently-skipped send.
    const rows = await db
      .update(communications)
      .set({ status: "execution_failed", provider: provider.name, error: result.reason, updatedAt: new Date() })
      .where(and(eq(communications.tenantId, tenantId), eq(communications.id, id)))
      .returning();
    return assertOne(rows, "executeCommunication");
  }

  // VERIFICATION: a real provider's own "sent" result already carries a
  // providerMessageId — the one and only fact available to confirm
  // against (no real provider exists yet to poll a delivery-status API
  // with; see provider.ts). Never invented: verification here means "the
  // configured provider itself reported this succeeded", nothing stronger
  // is claimed.
  const verified = Boolean(result.providerMessageId);
  const rows = await db
    .update(communications)
    .set({
      status: verified ? "verified" : "execution_failed",
      provider: provider.name,
      providerMessageId: result.providerMessageId,
      error: verified ? null : "provider reported 'sent' but returned no providerMessageId to verify against",
      updatedAt: new Date(),
    })
    .where(and(eq(communications.tenantId, tenantId), eq(communications.id, id)))
    .returning();
  return assertOne(rows, "executeCommunication");
}
