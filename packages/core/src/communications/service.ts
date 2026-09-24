import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb, communications, assertOne, type Communication } from "@bos/db";
import { evaluatePolicy } from "@bos/ai";
import { getClient } from "../clients";
import { getQuote } from "../quotes";
import { getDeal } from "../deals";
import { getConfiguredOutboundProvider, type OutboundProvider } from "./provider";
import { buildQuoteOfferContent } from "./content";
import type { CommunicationContent, PrepareQuoteOfferCommunicationInput } from "./schema";

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

  // Atomic claim before calling the provider: two concurrent calls (a
  // founder double-tap, a Meta webhook retry racing the original) can both
  // read status 'approved' above, but only one can set `provider` from
  // null. The loser returns the row as-is and never sends a second time.
  // Accepted trade-off: a process dying between this claim and the status
  // update below leaves the row 'approved' with provider set, and it is
  // never re-sent automatically — a missed message is recoverable by hand,
  // a duplicate one is not.
  const claimed = await db
    .update(communications)
    .set({ provider: provider.name, updatedAt: new Date() })
    .where(
      and(
        eq(communications.tenantId, tenantId),
        eq(communications.id, id),
        eq(communications.status, "approved"),
        isNull(communications.provider),
      ),
    )
    .returning();
  if (claimed.length === 0) {
    return (await getCommunication(tenantId, id)) ?? existing;
  }

  const content = existing.content as { to: string; body: string };

  let result: Awaited<ReturnType<OutboundProvider["send"]>>;
  try {
    result = await provider.send({
      channel: existing.channel,
      to: content.to,
      body: content.body,
      idempotencyKey: existing.idempotencyKey,
      tenantId,
      clientId: existing.clientId,
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

  // EXECUTED, not verified (Phase 3B Step 3 — the founder's own explicit
  // correction): a provider's synchronous "sent" result only proves the
  // provider ACCEPTED the request (for WhatsApp Cloud API, messages[0].id
  // on the POST response) — it is never proof of delivery or read.
  // "executed" is the honest ceiling of what this function alone can ever
  // claim. Reaching "verified" requires a real, separate confirmation —
  // see recordProviderDeliveryStatus below, driven by Meta's own
  // asynchronous status webhook callbacks
  // (packages/core/src/whatsapp/webhook-handler.ts).
  const rows = await db
    .update(communications)
    .set({
      status: "executed",
      provider: provider.name,
      providerMessageId: result.providerMessageId,
      error: null,
      updatedAt: new Date(),
    })
    .where(and(eq(communications.tenantId, tenantId), eq(communications.id, id)))
    .returning();
  return assertOne(rows, "executeCommunication");
}

// Correlates a Meta (or any future provider's) delivery-status callback
// back to the communication it belongs to. No tenant scoping: the webhook
// that calls this has no tenant context of its own (same reason
// whatsapp/service.ts's processInboundMessage resolves its own tenant) —
// providerMessageId (a WAMID) is Meta-global-unique by its own spec, not
// merely tenant-unique, so this is safe.
export async function findCommunicationByProviderMessageId(providerMessageId: string): Promise<Communication | null> {
  const db = getDb();
  const [row] = await db.select().from(communications).where(eq(communications.providerMessageId, providerMessageId));
  return row ?? null;
}

const DELIVERY_CONFIRMED_STATUSES = new Set(["delivered", "read"]);

// The other half of "executed != verified": called only from
// packages/core/src/whatsapp/webhook-handler.ts's statuses[] handling,
// never from executeCommunication itself. Fail-soft by design (returns
// null instead of throwing) for an unknown providerMessageId — a status
// callback for a message this system didn't send (or a duplicate Meta
// retry of an already-processed one) must never break the webhook's ACK
// to Meta.
//
// Idempotent by construction: "sent" never changes `status` at all (just
// records providerStatus — Meta's own confirmation of the same fact
// `executed` already represents). "delivered"/"read" only advance
// `status` to "verified" from "executed" specifically — a callback
// arriving after the communication is already "verified" (e.g. "read"
// after "delivered") or already terminal ("execution_failed"/"rejected")
// only updates the raw providerStatus trail, never re-fires a transition
// or a second verifiedAt write. "failed" only downgrades an "executed"
// (not-yet-verified) row to "execution_failed" — never overwrites an
// already-"verified" outcome, which represents a real confirmed delivery
// that already happened.
export async function recordProviderDeliveryStatus(
  providerMessageId: string,
  status: "sent" | "delivered" | "read" | "failed",
  occurredAt: Date,
): Promise<Communication | null> {
  const existing = await findCommunicationByProviderMessageId(providerMessageId);
  if (!existing) return null;

  const db = getDb();
  const patch: Record<string, unknown> = {
    providerStatus: status,
    providerStatusUpdatedAt: occurredAt,
    updatedAt: new Date(),
  };

  if (DELIVERY_CONFIRMED_STATUSES.has(status) && existing.status === "executed") {
    patch.status = "verified";
    patch.verifiedAt = occurredAt;
  } else if (status === "failed" && existing.status === "executed") {
    patch.status = "execution_failed";
    patch.error = "provider reported delivery failure via status callback";
  }

  const rows = await db
    .update(communications)
    .set(patch)
    .where(eq(communications.id, existing.id))
    .returning();
  return assertOne(rows, "recordProviderDeliveryStatus");
}

// ── WhatsApp quote approval flow (packages/core/src/quote-approval) ───────

interface InsertCommunicationRow {
  tenantId: string;
  clientId: string;
  dealId: string | null;
  transferRequestId: string | null;
  quoteId: string | null;
  action: string;
  agent: string;
  idempotencyKey: string;
  content: CommunicationContent;
  status: "prepared" | "approved";
  policyDecision: Record<string, unknown> | null;
}

// INSERT ... ON CONFLICT DO NOTHING on the (tenant_id, idempotency_key)
// unique constraint, falling back to the existing row — same pattern as
// prepareQuoteOfferCommunication above.
async function insertCommunicationOnce(row: InsertCommunicationRow, caller: string): Promise<Communication> {
  const db = getDb();
  const insertedRows = await db.execute<Communication>(sql`
    insert into communications (
      tenant_id, client_id, deal_id, transfer_request_id, quote_id, booking_id,
      channel, action, agent, correlation_id, idempotency_key, content, status, policy_decision
    ) values (
      ${row.tenantId}, ${row.clientId}, ${row.dealId}, ${row.transferRequestId}, ${row.quoteId}, ${null},
      ${"whatsapp"}, ${row.action}, ${row.agent}, ${null}, ${row.idempotencyKey},
      ${JSON.stringify(row.content)}::jsonb, ${row.status},
      ${row.policyDecision ? JSON.stringify(row.policyDecision) : null}::jsonb
    )
    on conflict (tenant_id, idempotency_key) do nothing
    returning *
  `);

  if (insertedRows.length > 0) {
    return assertOne(insertedRows, caller);
  }

  const existing = await findCommunicationByIdempotencyKey(row.tenantId, row.idempotencyKey);
  if (!existing) {
    throw new Error(`${caller}: insert conflicted but no existing communication was found`);
  }
  return existing;
}

export interface SendMissingInfoRequestInput {
  tenantId: string;
  clientId: string;
  dealId: string | null;
  transferRequestId: string;
  // whatsapp_messages.id of the customer message being answered — at most
  // one question per inbound message, including across Meta retries.
  inboundMessageRowId: string;
  content: CommunicationContent;
}

// The one customer-facing message that skips human approval, by explicit
// founder decision (2026-09-24): a fixed-text question listing missing trip
// data, never a price. Recorded as 'approved' with that rule as its policy
// decision, then sent through the same executeCommunication path as
// everything else.
export async function sendMissingInfoRequest(
  input: SendMissingInfoRequestInput,
  provider: OutboundProvider = getConfiguredOutboundProvider(),
): Promise<Communication> {
  const row = await insertCommunicationOnce(
    {
      tenantId: input.tenantId,
      clientId: input.clientId,
      dealId: input.dealId,
      transferRequestId: input.transferRequestId,
      quoteId: null,
      action: "missing_info_request",
      agent: "system",
      idempotencyKey: `missing_info:${input.inboundMessageRowId}`,
      content: input.content,
      status: "approved",
      policyDecision: {
        allowed: true,
        requiresApproval: false,
        rule: "founder_decision_2026_09_24_missing_info_auto",
        reason: "fixed-text request for missing trip data; contains no price",
      },
    },
    "sendMissingInfoRequest",
  );
  return executeCommunication(input.tenantId, row.id, provider);
}

export interface PrepareTransferQuoteOfferInput {
  tenantId: string;
  clientId: string;
  dealId: string | null;
  transferRequestId: string;
  quoteId: string | null;
  content: CommunicationContent;
}

// Keyed by transfer_request, not quote: ensureQuoteForDeal (transfer-requests)
// reuses a deal's existing quote row, so a quote id can be shared by two
// attempts and would dedupe the second offer away. The caller builds the
// content from transfer_requests.final_amount_cents (the approved price).
export async function prepareTransferQuoteOfferCommunication(
  input: PrepareTransferQuoteOfferInput,
): Promise<Communication> {
  return insertCommunicationOnce(
    {
      tenantId: input.tenantId,
      clientId: input.clientId,
      dealId: input.dealId,
      transferRequestId: input.transferRequestId,
      quoteId: input.quoteId,
      action: "quote_offer",
      agent: "operations",
      idempotencyKey: `transfer_quote_offer:${input.transferRequestId}`,
      content: input.content,
      status: "prepared",
      policyDecision: null,
    },
    "prepareTransferQuoteOfferCommunication",
  );
}
