import type { QuoteApprovalRequest, TransferRequest } from "@bos/db";
import {
  getTransferRequest,
  acceptTransferRequest,
  rejectTransferRequest,
  modifyPriceForTransferRequest,
} from "../transfer-requests";
import { getClient } from "../clients";
import {
  sendMissingInfoRequest,
  hasCommunicationForTransferRequest,
  prepareTransferQuoteOfferCommunication,
  submitCommunicationForApproval,
  approveCommunication,
  executeCommunication,
  buildMissingInfoRequestContent,
  buildTransferQuoteOfferContent,
  toCustomerLanguage,
} from "../communications";
import { getLastInboundWhatsappPhoneE164, normalizePhone } from "../whatsapp";
import { log, captureException } from "../observability";
import * as repo from "./repository";
import { sendToFounder } from "./founder-channel";
import { isCustomerPhoneAllowed, isQuoteApprovalEnabled } from "./config";
import {
  APPROVAL_BUTTONS,
  FOUNDER_TEXTS,
  buildManualPriceText,
  buildQuoteReadyText,
  decodeButtonId,
  encodeButtonId,
  isTypedCommand,
  parseFounderPrice,
  shortRef,
  type ApprovalAction,
} from "./content";

// ── Customer side ─────────────────────────────────────────────────────────

export interface CustomerMessageOutcome {
  tenantId: string;
  clientId: string;
  // whatsapp_messages.id of the message just processed
  inboundMessageRowId: string;
  // Meta's `from` for that message (digits only)
  fromPhone: string;
  extracted: {
    intent?: string;
    pickup?: string;
    destination?: string;
    date?: string;
    time?: string;
    passengers?: number;
    flight?: string;
    luggage?: string;
    children?: number;
    childrenAges?: string;
  };
  transferRequest: TransferRequest;
}

// A "ciao", "grazie" or a question about something else must not trigger a
// list of trip questions: ask only when the message is about a trip.
function looksLikeTripMessage(extracted: CustomerMessageOutcome["extracted"]): boolean {
  if (
    extracted.pickup ||
    extracted.destination ||
    extracted.date ||
    extracted.time ||
    extracted.passengers ||
    extracted.flight ||
    extracted.luggage ||
    extracted.children !== undefined
  ) {
    return true;
  }
  return !!extracted.intent && /transfer|booking|quote|preventiv|prenot|trip|ride/i.test(extracted.intent);
}

// Called by the WhatsApp webhook after every customer message has gone
// through transfer-requests (and pricing, when it became complete).
export async function handleCustomerMessageOutcome(input: CustomerMessageOutcome): Promise<void> {
  if (!isQuoteApprovalEnabled()) return;
  if (!isCustomerPhoneAllowed(input.fromPhone)) {
    log("quote_approval.customer_not_in_test_phones", { transferRequestId: input.transferRequest.id });
    return;
  }
  const tr = input.transferRequest;

  if (tr.status === "collecting_info") {
    if (looksLikeTripMessage(input.extracted)) {
      await askCustomerForMissingInfo(input);
    }
    return;
  }

  if (tr.status === "pending_admin_approval") {
    await ensureFounderNotified(input.tenantId, tr, "quote_ready");
    return;
  }

  if (tr.status === "ready_for_pricing" && tr.pricingStatus === "manual_required") {
    await ensureFounderNotified(input.tenantId, tr, "manual_price_required");
  }
}

async function askCustomerForMissingInfo(input: CustomerMessageOutcome): Promise<void> {
  const tr = input.transferRequest;
  const missing = tr.missingInformation ?? [];
  if (missing.length === 0) return;

  const digits = normalizePhone(input.fromPhone);
  if (!digits) return;

  const isFollowUp = await hasCommunicationForTransferRequest(input.tenantId, tr.id, "missing_info_request");
  const content = buildMissingInfoRequestContent({
    to: `+${digits}`,
    language: toCustomerLanguage(tr.language),
    missing,
    askChildren: tr.children === null,
    askChildrenAges: (tr.children ?? 0) > 0 && !tr.childrenAges,
    askLuggage: !tr.luggage,
    isFollowUp,
  });

  const communication = await sendMissingInfoRequest({
    tenantId: input.tenantId,
    clientId: input.clientId,
    dealId: tr.dealId,
    transferRequestId: tr.id,
    inboundMessageRowId: input.inboundMessageRowId,
    content,
  });
  log("quote_approval.missing_info_request", {
    transferRequestId: tr.id,
    communicationId: communication.id,
    status: communication.status,
  });
}

// ── Founder notifications ────────────────────────────────────────────────

async function ensureFounderNotified(
  tenantId: string,
  tr: TransferRequest,
  kind: repo.ApprovalKind,
): Promise<void> {
  const row = await repo.insertApprovalRequestOnce({
    tenantId,
    transferRequestId: tr.id,
    clientId: tr.clientId,
    kind,
    round: 1,
    status: kind === "quote_ready" ? "awaiting_decision" : "info",
    proposedAmountCents: null,
  });
  if (!row) return;
  if (!(await repo.claimNotification(tenantId, row.id))) return;
  await deliverNotification(tenantId, row, tr);
}

async function deliverNotification(tenantId: string, row: QuoteApprovalRequest, tr: TransferRequest): Promise<void> {
  const client = await getClient(tenantId, tr.clientId);
  if (!client) {
    await repo.recordNotificationOutcome(tenantId, row.id, {
      status: "failed",
      channel: null,
      error: `client ${tr.clientId} not found`,
    });
    return;
  }

  let result;
  if (row.kind === "manual_price_required") {
    result = await sendToFounder(tenantId, {
      parts: [buildManualPriceText(tr, client)],
      emailSubject: `PREZZO DA INSERIRE ${shortRef(tr.id)}`,
    });
  } else {
    const amountCents = row.proposedAmountCents ?? tr.calculatedAmountCents;
    if (amountCents === null) {
      await repo.recordNotificationOutcome(tenantId, row.id, {
        status: "failed",
        channel: null,
        error: "no price on transfer_request",
      });
      return;
    }
    const preview = buildCustomerQuoteContent(tr, amountCents, "");
    const text = buildQuoteReadyText({
      tr,
      client,
      proposedAmountCents: row.proposedAmountCents,
      customerMessageBody: preview.body,
    });
    result = await sendToFounder(tenantId, {
      parts: [text.customerPreview, text.details],
      buttons: APPROVAL_BUTTONS.map((b) => ({ id: encodeButtonId(row.id, b.action), title: b.title })),
      emailSubject: `PREVENTIVO PRONTO ${shortRef(tr.id)}`,
    });
  }

  await repo.recordNotificationOutcome(tenantId, row.id, {
    status: result.channel === "whatsapp" ? "sent_whatsapp" : result.channel === "email" ? "sent_email" : "failed",
    channel: result.channel === "none" ? null : result.channel,
    error: result.error,
  });
}

function buildCustomerQuoteContent(tr: TransferRequest, amountCents: number, to: string) {
  if (!tr.pickup || !tr.destination || !tr.requestedDate || !tr.requestedTime || !tr.passengers) {
    throw new Error(`transfer_request ${tr.id} is missing trip data required for a quote`);
  }
  return buildTransferQuoteOfferContent({
    to,
    language: toCustomerLanguage(tr.language),
    pickup: tr.pickup,
    destination: tr.destination,
    requestedDate: tr.requestedDate,
    requestedTime: tr.requestedTime,
    passengers: tr.passengers,
    flightNumber: tr.flightNumber,
    amountCents,
    currency: tr.currency,
  });
}

// ── Founder side ─────────────────────────────────────────────────────────

export interface FounderInboundMessage {
  waMessageId: string;
  type: string;
  rawText: string | null;
  buttonId?: string;
  receivedAt: Date;
}

async function reply(tenantId: string, text: string): Promise<void> {
  await sendToFounder(tenantId, { parts: [text], emailSubject: "BOS — risposta al tuo comando WhatsApp" });
}

// Entry point for every message from FOUNDER_WHATSAPP_PHONE. These never go
// through client matching or transfer_requests.
export async function handleFounderMessage(message: FounderInboundMessage): Promise<void> {
  if (!isQuoteApprovalEnabled()) return;
  const tenantId = await repo.getDefaultTenantId();
  const isNew = await repo.recordFounderMessage(tenantId, message);
  if (!isNew) return;

  if (message.buttonId) {
    const decoded = decodeButtonId(message.buttonId);
    if (!decoded) {
      await reply(tenantId, FOUNDER_TEXTS.unknownButton);
      return;
    }
    await handleButton(tenantId, decoded.approvalRequestId, decoded.action);
    return;
  }

  const text = message.rawText?.trim() ?? "";
  if (text) {
    const [awaitingPrice] = await repo.listApprovalRequestsByStatus(tenantId, ["awaiting_price"]);
    if (awaitingPrice) {
      const amountCents = parseFounderPrice(text);
      if (amountCents !== null) {
        await handlePriceReply(tenantId, awaitingPrice, amountCents);
        return;
      }
      // Not a price: falls through to resendPending, which repeats the
      // "waiting for your price" reminder along with the other quotes.
    }
    if (isTypedCommand(text)) {
      await reply(tenantId, FOUNDER_TEXTS.useButtons);
    }
  }

  await resendPending(tenantId);
}

async function resendPending(tenantId: string): Promise<void> {
  const rows = await repo.listApprovalRequestsByStatus(tenantId, ["awaiting_decision", "awaiting_price"]);
  let sent = 0;

  for (const row of rows) {
    if (row.kind !== "quote_ready") continue;
    const tr = await getTransferRequest(tenantId, row.transferRequestId);
    if (!tr || tr.status !== "pending_admin_approval") {
      // Decided elsewhere (admin panel) since the notification went out.
      await repo.transitionApprovalRequest(tenantId, row.id, ["awaiting_decision", "awaiting_price"], "superseded");
      continue;
    }
    const customerPhone = await getLastInboundWhatsappPhoneE164(tenantId, tr.clientId);
    if (!customerPhone || !isCustomerPhoneAllowed(customerPhone)) continue;
    if (row.status === "awaiting_price") {
      await reply(tenantId, FOUNDER_TEXTS.awaitingPriceReminder(shortRef(tr.id)));
    } else {
      await deliverNotification(tenantId, row, tr);
    }
    sent++;
  }

  if (sent === 0) {
    await reply(tenantId, FOUNDER_TEXTS.nothingPending);
  }
}

async function replyForSettledStatus(tenantId: string, row: QuoteApprovalRequest): Promise<void> {
  const ref = shortRef(row.transferRequestId);
  switch (row.status) {
    case "approved":
      return reply(tenantId, FOUNDER_TEXTS.alreadyApproved(ref));
    case "rejected":
      return reply(tenantId, FOUNDER_TEXTS.alreadyRejected(ref));
    case "processing":
      return reply(tenantId, FOUNDER_TEXTS.inProgress(ref));
    default:
      return reply(tenantId, FOUNDER_TEXTS.superseded(ref));
  }
}

async function handleButton(tenantId: string, approvalRequestId: string, action: ApprovalAction): Promise<void> {
  const row = await repo.getApprovalRequest(tenantId, approvalRequestId);
  if (!row || row.kind !== "quote_ready") {
    await reply(tenantId, FOUNDER_TEXTS.notFound);
    return;
  }

  if (action === "modify") {
    await handleModify(tenantId, row);
    return;
  }

  const claimed = await repo.transitionApprovalRequest(
    tenantId,
    row.id,
    ["awaiting_decision", "awaiting_price"],
    "processing",
    {},
    { reclaimStaleProcessing: true },
  );
  if (!claimed) {
    const current = (await repo.getApprovalRequest(tenantId, row.id)) ?? row;
    await replyForSettledStatus(tenantId, current);
    return;
  }

  if (action === "approve") {
    await handleApprove(tenantId, claimed);
  } else {
    await handleReject(tenantId, claimed);
  }
}

async function handleModify(tenantId: string, row: QuoteApprovalRequest): Promise<void> {
  const ref = shortRef(row.transferRequestId);
  if (row.status === "awaiting_price") {
    await reply(tenantId, FOUNDER_TEXTS.askPrice(ref));
    return;
  }
  if (row.status !== "awaiting_decision") {
    await replyForSettledStatus(tenantId, row);
    return;
  }

  // Only one quote at a time may wait for a typed price, so a bare "280"
  // is never ambiguous. Any other one goes back to waiting for a button.
  for (const other of await repo.listApprovalRequestsByStatus(tenantId, ["awaiting_price"])) {
    if (other.id !== row.id) {
      await repo.transitionApprovalRequest(tenantId, other.id, ["awaiting_price"], "awaiting_decision");
    }
  }

  const updated = await repo.transitionApprovalRequest(tenantId, row.id, ["awaiting_decision"], "awaiting_price");
  if (!updated) {
    const current = (await repo.getApprovalRequest(tenantId, row.id)) ?? row;
    await replyForSettledStatus(tenantId, current);
    return;
  }
  await reply(tenantId, FOUNDER_TEXTS.askPrice(ref));
}

async function handlePriceReply(tenantId: string, row: QuoteApprovalRequest, amountCents: number): Promise<void> {
  const ref = shortRef(row.transferRequestId);
  const tr = await getTransferRequest(tenantId, row.transferRequestId);
  if (!tr || tr.status !== "pending_admin_approval") {
    await repo.transitionApprovalRequest(tenantId, row.id, ["awaiting_price"], "superseded");
    await reply(tenantId, FOUNDER_TEXTS.noLongerPending(ref, tr?.status ?? "non trovato"));
    return;
  }

  const superseded = await repo.transitionApprovalRequest(tenantId, row.id, ["awaiting_price"], "superseded");
  if (!superseded) {
    const current = (await repo.getApprovalRequest(tenantId, row.id)) ?? row;
    await replyForSettledStatus(tenantId, current);
    return;
  }

  const next = await repo.insertApprovalRequestOnce({
    tenantId,
    transferRequestId: tr.id,
    clientId: tr.clientId,
    kind: "quote_ready",
    round: row.round + 1,
    status: "awaiting_decision",
    proposedAmountCents: amountCents,
  });
  if (!next) {
    await reply(tenantId, FOUNDER_TEXTS.error(ref, "impossibile creare il nuovo preventivo"));
    return;
  }
  if (await repo.claimNotification(tenantId, next.id)) {
    await deliverNotification(tenantId, next, tr);
  }
}

function getFounderProfileId(): string | null {
  const id = process.env.FOUNDER_PROFILE_ID?.trim();
  return id ? id : null;
}

async function releaseClaim(tenantId: string, row: QuoteApprovalRequest, error: string): Promise<void> {
  await repo.transitionApprovalRequest(tenantId, row.id, ["processing"], "awaiting_decision", { decisionError: error });
}

async function handleApprove(tenantId: string, row: QuoteApprovalRequest): Promise<void> {
  const ref = shortRef(row.transferRequestId);

  const founderProfileId = getFounderProfileId();
  if (!founderProfileId || !(await repo.isAdminProfile(tenantId, founderProfileId))) {
    await releaseClaim(tenantId, row, "FOUNDER_PROFILE_ID missing or not an admin profile");
    await reply(tenantId, FOUNDER_TEXTS.configError("FOUNDER_PROFILE_ID (deve essere il tuo profilo admin)"));
    return;
  }

  const tr = await getTransferRequest(tenantId, row.transferRequestId);
  if (!tr || (tr.status !== "pending_admin_approval" && tr.status !== "approved")) {
    await repo.transitionApprovalRequest(tenantId, row.id, ["processing"], "superseded");
    await reply(tenantId, FOUNDER_TEXTS.noLongerPending(ref, tr?.status ?? "non trovato"));
    return;
  }

  const expectedAmount = row.proposedAmountCents ?? tr.calculatedAmountCents;
  if (tr.status === "approved" && tr.finalAmountCents !== expectedAmount) {
    // Approved from the admin panel at a different price: never send the
    // customer a price the founder didn't see in this message.
    await repo.transitionApprovalRequest(tenantId, row.id, ["processing"], "superseded");
    await reply(tenantId, FOUNDER_TEXTS.priceMismatch(ref));
    return;
  }

  // Resolved and checked BEFORE approving: in test mode a customer outside
  // QUOTE_APPROVAL_TEST_PHONES must not end up with an approved request (and
  // a booking) that nobody sends.
  const to = await getLastInboundWhatsappPhoneE164(tenantId, tr.clientId);
  if (!to) {
    await releaseClaim(tenantId, row, "no customer WhatsApp number");
    await reply(tenantId, FOUNDER_TEXTS.error(ref, "nessun numero WhatsApp del cliente trovato"));
    return;
  }
  if (!isCustomerPhoneAllowed(to)) {
    await releaseClaim(tenantId, row, "customer not in QUOTE_APPROVAL_TEST_PHONES");
    await reply(tenantId, FOUNDER_TEXTS.notATestPhone(ref));
    return;
  }

  let approved: TransferRequest;
  let communicationId: string;
  let communicationStatus: string;
  let communicationError: string | null;
  try {
    if (tr.status === "approved") {
      // A retry after a failure further down: ACCEPT is the documented
      // idempotent way to reconcile an already-approved request.
      approved = await acceptTransferRequest(tenantId, tr.id, founderProfileId);
    } else if (row.proposedAmountCents !== null) {
      approved = await modifyPriceForTransferRequest(
        tenantId,
        tr.id,
        founderProfileId,
        row.proposedAmountCents,
        "Prezzo modificato dal titolare via WhatsApp",
      );
    } else {
      approved = await acceptTransferRequest(tenantId, tr.id, founderProfileId);
    }

    if (approved.finalAmountCents === null) {
      throw new Error("approved transfer_request has no final_amount_cents");
    }
    const prepared = await prepareTransferQuoteOfferCommunication({
      tenantId,
      clientId: approved.clientId,
      dealId: approved.dealId,
      transferRequestId: approved.id,
      quoteId: approved.quoteId,
      content: buildCustomerQuoteContent(approved, approved.finalAmountCents, to),
    });
    await submitCommunicationForApproval(tenantId, prepared.id);
    await approveCommunication(tenantId, prepared.id, founderProfileId);
    const executed = await executeCommunication(tenantId, prepared.id);
    communicationId = executed.id;
    communicationStatus = executed.status;
    communicationError = executed.error;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    captureException(error, "quote_approval.approve_failed", { transferRequestId: tr.id });
    await releaseClaim(tenantId, row, message);
    await reply(tenantId, FOUNDER_TEXTS.error(ref, message));
    return;
  }

  await repo.transitionApprovalRequest(tenantId, row.id, ["processing"], "approved", {
    decidedAt: new Date(),
    customerCommunicationId: communicationId,
    decisionError: communicationStatus === "execution_failed" ? communicationError : null,
  });

  if (communicationStatus === "executed" || communicationStatus === "verified") {
    await reply(tenantId, FOUNDER_TEXTS.approvedSent(ref));
  } else if (communicationStatus === "execution_failed") {
    await reply(tenantId, FOUNDER_TEXTS.approvedSendFailed(ref, communicationError ?? "errore sconosciuto"));
  } else {
    await reply(tenantId, FOUNDER_TEXTS.approvedSendInProgress(ref));
  }
}

async function handleReject(tenantId: string, row: QuoteApprovalRequest): Promise<void> {
  const ref = shortRef(row.transferRequestId);
  try {
    await rejectTransferRequest(tenantId, row.transferRequestId, "via WhatsApp");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const tr = await getTransferRequest(tenantId, row.transferRequestId);
    if (tr && tr.status !== "pending_admin_approval") {
      await repo.transitionApprovalRequest(tenantId, row.id, ["processing"], "superseded");
      await reply(tenantId, FOUNDER_TEXTS.noLongerPending(ref, tr.status));
      return;
    }
    await releaseClaim(tenantId, row, message);
    await reply(tenantId, FOUNDER_TEXTS.error(ref, message));
    return;
  }

  await repo.transitionApprovalRequest(tenantId, row.id, ["processing"], "rejected", { decidedAt: new Date() });
  await reply(tenantId, FOUNDER_TEXTS.rejected(ref));
}
