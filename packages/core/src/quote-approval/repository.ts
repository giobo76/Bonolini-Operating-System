import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import {
  getDb,
  tenants,
  profiles,
  founderWhatsappMessages,
  quoteApprovalRequests,
  type QuoteApprovalRequest,
} from "@bos/db";

// Every database read/write of this module. service.ts depends only on
// these functions, so its tests replace this file with an in-memory fake
// instead of mocking drizzle's query builder.

export type ApprovalKind = "quote_ready" | "manual_price_required";
export type ApprovalStatus =
  | "awaiting_decision"
  | "awaiting_price"
  | "processing"
  | "approved"
  | "rejected"
  | "superseded"
  | "info";
export type NotificationStatus = "pending" | "sending" | "sent_whatsapp" | "sent_email" | "failed";

// A row left in 'processing'/'sending' by a crashed invocation becomes
// claimable again after this long. Every step behind the claim is
// idempotent, and the customer send has its own claim in
// executeCommunication, so a reclaim can never double-send.
const STALE_CLAIM_MS = 5 * 60 * 1000;

export async function getDefaultTenantId(): Promise<string> {
  const db = getDb();
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, "bonolini-transfer"));
  if (!tenant) {
    throw new Error('Default tenant "bonolini-transfer" not found — was 0000_init.sql applied?');
  }
  return tenant.id;
}

export async function isAdminProfile(tenantId: string, profileId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.id, profileId), eq(profiles.tenantId, tenantId), eq(profiles.role, "admin")));
  return rows.length > 0;
}

// false when this exact Meta message was already recorded (webhook retry).
export async function recordFounderMessage(
  tenantId: string,
  message: { waMessageId: string; type: string; rawText: string | null; buttonId?: string; receivedAt: Date },
): Promise<boolean> {
  const db = getDb();
  const inserted = await db
    .insert(founderWhatsappMessages)
    .values({
      tenantId,
      whatsappMessageId: message.waMessageId,
      type: message.type,
      rawText: message.rawText,
      buttonId: message.buttonId ?? null,
      receivedAt: message.receivedAt,
    })
    .onConflictDoNothing()
    .returning({ id: founderWhatsappMessages.id });
  return inserted.length > 0;
}

export async function getFounderLastInboundAt(tenantId: string): Promise<Date | null> {
  const db = getDb();
  const [row] = await db
    .select({ receivedAt: founderWhatsappMessages.receivedAt })
    .from(founderWhatsappMessages)
    .where(eq(founderWhatsappMessages.tenantId, tenantId))
    .orderBy(desc(founderWhatsappMessages.receivedAt))
    .limit(1);
  return row?.receivedAt ?? null;
}

export async function getApprovalRequest(tenantId: string, id: string): Promise<QuoteApprovalRequest | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(quoteApprovalRequests)
    .where(and(eq(quoteApprovalRequests.tenantId, tenantId), eq(quoteApprovalRequests.id, id)));
  return row ?? null;
}

export async function listApprovalRequestsByStatus(
  tenantId: string,
  statuses: ApprovalStatus[],
): Promise<QuoteApprovalRequest[]> {
  const db = getDb();
  return db
    .select()
    .from(quoteApprovalRequests)
    .where(and(eq(quoteApprovalRequests.tenantId, tenantId), inArray(quoteApprovalRequests.status, statuses)))
    .orderBy(quoteApprovalRequests.createdAt);
}

// Returns the row for (transfer_request, kind, round) — freshly inserted or
// already existing. null only when the insert hit the "one open round per
// transfer_request" index for a different round.
export async function insertApprovalRequestOnce(input: {
  tenantId: string;
  transferRequestId: string;
  clientId: string;
  kind: ApprovalKind;
  round: number;
  status: ApprovalStatus;
  proposedAmountCents: number | null;
  proposedDepositCents?: number | null;
}): Promise<QuoteApprovalRequest | null> {
  const db = getDb();
  const inserted = await db
    .insert(quoteApprovalRequests)
    .values({
      tenantId: input.tenantId,
      transferRequestId: input.transferRequestId,
      clientId: input.clientId,
      kind: input.kind,
      round: input.round,
      status: input.status,
      proposedAmountCents: input.proposedAmountCents,
      proposedDepositCents: input.proposedDepositCents ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  const [existing] = await db
    .select()
    .from(quoteApprovalRequests)
    .where(
      and(
        eq(quoteApprovalRequests.tenantId, input.tenantId),
        eq(quoteApprovalRequests.transferRequestId, input.transferRequestId),
        eq(quoteApprovalRequests.kind, input.kind),
        eq(quoteApprovalRequests.round, input.round),
      ),
    );
  return existing ?? null;
}

// Conditional status change: succeeds only if the row is currently in one
// of `from` (or is a stale 'processing' claim, when `reclaimStaleProcessing`).
// This is what makes a double tap harmless — the second tap finds nothing
// to transition and gets null.
export async function transitionApprovalRequest(
  tenantId: string,
  id: string,
  from: ApprovalStatus[],
  to: ApprovalStatus,
  extra: Partial<Pick<QuoteApprovalRequest, "decidedAt" | "decisionError" | "customerCommunicationId">> = {},
  options: { reclaimStaleProcessing?: boolean } = {},
): Promise<QuoteApprovalRequest | null> {
  const db = getDb();
  const statusCondition = options.reclaimStaleProcessing
    ? or(
        inArray(quoteApprovalRequests.status, from),
        and(
          eq(quoteApprovalRequests.status, "processing"),
          lt(quoteApprovalRequests.updatedAt, new Date(Date.now() - STALE_CLAIM_MS)),
        ),
      )
    : inArray(quoteApprovalRequests.status, from);

  const rows = await db
    .update(quoteApprovalRequests)
    .set({ status: to, ...extra, updatedAt: new Date() })
    .where(and(eq(quoteApprovalRequests.tenantId, tenantId), eq(quoteApprovalRequests.id, id), statusCondition))
    .returning();
  return rows[0] ?? null;
}

// Claims the right to send this row's founder notification. false when it
// was already sent, or another invocation is sending it right now.
export async function claimNotification(tenantId: string, id: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .update(quoteApprovalRequests)
    .set({ notificationStatus: "sending", updatedAt: new Date() })
    .where(
      and(
        eq(quoteApprovalRequests.tenantId, tenantId),
        eq(quoteApprovalRequests.id, id),
        or(
          eq(quoteApprovalRequests.notificationStatus, "pending"),
          and(
            eq(quoteApprovalRequests.notificationStatus, "sending"),
            lt(quoteApprovalRequests.updatedAt, new Date(Date.now() - STALE_CLAIM_MS)),
          ),
        ),
      ),
    )
    .returning({ id: quoteApprovalRequests.id });
  return rows.length > 0;
}

export async function recordNotificationOutcome(
  tenantId: string,
  id: string,
  outcome: { status: NotificationStatus; channel: string | null; error: string | null },
): Promise<void> {
  const db = getDb();
  await db
    .update(quoteApprovalRequests)
    .set({
      notificationStatus: outcome.status,
      notificationChannel: outcome.channel,
      notificationError: outcome.error,
      ...(outcome.status === "sent_whatsapp" || outcome.status === "sent_email" ? { notifiedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(quoteApprovalRequests.tenantId, tenantId), eq(quoteApprovalRequests.id, id)));
}
