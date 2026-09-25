import type { Booking, Client, Communication, QuoteApprovalRequest, TransferRequest } from "@bos/db";
import {
  getTransferRequest,
  acceptTransferRequest,
  rejectTransferRequest,
  modifyPriceForTransferRequest,
  enterManualPriceForTransferRequest,
} from "../transfer-requests";
import { getClient } from "../clients";
import {
  getBooking,
  getBookingByTransferRequestId,
  listPendingDepositBookings,
  confirmBookingDeposit,
} from "../bookings";
import { computeDefaultDepositCents, isValidDeposit } from "../pricing";
import {
  sendMissingInfoRequest,
  sendBookingConfirmation,
  prepareTransferQuoteOfferCommunication,
  submitCommunicationForApproval,
  approveCommunication,
  executeCommunicationDetailed,
  buildMissingInfoRequestContent,
  buildTransferQuoteOfferContent,
  buildBookingConfirmationContent,
  formatAmountForCustomer,
  toCustomerLanguage,
  type ExecutionResult,
} from "../communications";
import { getLastInboundWhatsappPhoneE164, normalizePhone } from "../whatsapp";
import { log, captureException } from "../observability";
import * as repo from "./repository";
import { sendToFounder, type FounderButton } from "./founder-channel";
import { adminLink, isCustomerPhoneAllowed, isQuoteApprovalEnabled } from "./config";
import {
  APPROVAL_BUTTONS,
  DEPOSIT_BUTTON_TITLE,
  FOUNDER_TEXTS,
  buildCustomerSendFailureText,
  buildDepositPendingText,
  buildManualPriceText,
  buildQuoteReadyText,
  decodeButtonId,
  decodeDepositButtonId,
  encodeButtonId,
  encodeDepositButtonId,
  isTypedCommand,
  parseFounderPriceAndDeposit,
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

  const content = buildMissingInfoRequestContent({
    to: `+${digits}`,
    language: toCustomerLanguage(tr.language),
    missing,
    askChildren: tr.children === null,
    askChildrenAges: (tr.children ?? 0) > 0 && !tr.childrenAges,
    askLuggage: !tr.luggage,
  });

  const result = await sendMissingInfoRequest({
    tenantId: input.tenantId,
    clientId: input.clientId,
    dealId: tr.dealId,
    transferRequestId: tr.id,
    inboundMessageRowId: input.inboundMessageRowId,
    content,
  });
  log("quote_approval.missing_info_request", {
    transferRequestId: tr.id,
    communicationId: result.communication.id,
    status: result.communication.status,
  });
  await alertIfCustomerSendFailed(input.tenantId, tr, result, "la domanda sui dati mancanti");
}

// One email per failed customer send: only the call that actually attempted
// the send (ExecutionResult.attempted) reports it, so retries and duplicate
// webhooks never repeat the alert.
async function alertIfCustomerSendFailed(
  tenantId: string,
  tr: TransferRequest,
  result: ExecutionResult,
  what: string,
): Promise<void> {
  const communication: Communication = result.communication;
  if (!result.attempted || communication.status !== "execution_failed") return;
  try {
    const client = await getClient(tenantId, tr.clientId);
    const content = communication.content as { body?: string };
    await sendToFounder(tenantId, {
      parts: [
        buildCustomerSendFailureText({
          what,
          ref: shortRef(tr.id),
          clientName: client?.fullName ?? "cliente",
          clientPhone: client?.phone ?? "",
          error: communication.error ?? "errore sconosciuto",
          body: content.body ?? "",
        }),
      ],
      link: linkTo(`/preventivi`, FOUNDER_TEXTS.openPendingLink),
      emailSubject: `INVIO AL CLIENTE NON RIUSCITO ${shortRef(tr.id)}`,
    });
  } catch (error) {
    captureException(error, "quote_approval.send_failure_alert_failed", { transferRequestId: tr.id });
  }
}

function linkTo(path: string, label: string) {
  const url = adminLink(path);
  return url ? { label, url } : null;
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
      link: linkTo(`/preventivi`, FOUNDER_TEXTS.openPendingLink),
      emailSubject: `PREZZO DA INSERIRE ${shortRef(tr.id)}`,
    });
  } else {
    const view = buildRoundView(row, tr, client);
    if (!view) {
      await repo.recordNotificationOutcome(tenantId, row.id, {
        status: "failed",
        channel: null,
        error: "no price on transfer_request",
      });
      return;
    }
    result = await sendToFounder(tenantId, {
      parts: [view.founderDetails, view.customerPreviewWithTitle],
      buttons: APPROVAL_BUTTONS.map((b) => ({ id: encodeButtonId(row.id, b.action), title: b.title })),
      link: linkTo(`/preventivi/${row.id}`, FOUNDER_TEXTS.openQuoteLink),
      emailSubject: `PREVENTIVO PRONTO ${shortRef(tr.id)}`,
    });
  }

  await repo.recordNotificationOutcome(tenantId, row.id, {
    status: result.channel === "whatsapp" ? "sent_whatsapp" : result.channel === "email" ? "sent_email" : "failed",
    channel: result.channel === "none" ? null : result.channel,
    error: result.error,
  });
}

// The deposit a round proposes: the founder's own (Modifica with an
// acconto) or the default 50% rule on that round's price.
function depositForRound(row: QuoteApprovalRequest, amountCents: number): number {
  return row.proposedDepositCents ?? computeDefaultDepositCents(amountCents);
}

function tripDetails(tr: TransferRequest) {
  if (!tr.pickup || !tr.destination || !tr.requestedDate || !tr.requestedTime || !tr.passengers) {
    throw new Error(`transfer_request ${tr.id} is missing trip data required for a quote`);
  }
  return {
    language: toCustomerLanguage(tr.language),
    pickup: tr.pickup,
    destination: tr.destination,
    requestedDate: tr.requestedDate,
    requestedTime: tr.requestedTime,
    passengers: tr.passengers,
    children: tr.children,
    childrenAges: tr.childrenAges,
    luggage: tr.luggage,
    flightNumber: tr.flightNumber,
  };
}

function buildCustomerQuoteContent(tr: TransferRequest, amountCents: number, depositCents: number, to: string) {
  return buildTransferQuoteOfferContent({ ...tripDetails(tr), to, amountCents, depositCents, currency: tr.currency });
}

// What the founder sees for one round, in the email and in the panel: the
// exact customer text, built by the same function that builds the real one.
export interface RoundView {
  amountCents: number;
  amountLabel: string;
  depositCents: number;
  depositLabel: string;
  founderDetails: string;
  customerPreview: string;
  customerPreviewWithTitle: string;
}

function buildRoundView(row: QuoteApprovalRequest, tr: TransferRequest, client: Client): RoundView | null {
  const amountCents = row.proposedAmountCents ?? tr.calculatedAmountCents;
  if (amountCents === null) return null;
  const depositCents = depositForRound(row, amountCents);
  const preview = buildCustomerQuoteContent(tr, amountCents, depositCents, "");
  const text = buildQuoteReadyText({
    tr,
    client,
    proposedAmountCents: row.proposedAmountCents,
    depositCents,
    depositIsCustom: row.proposedDepositCents !== null,
    customerMessageBody: preview.body,
  });
  return {
    amountCents,
    amountLabel: formatAmountForCustomer(amountCents, tr.currency, "it"),
    depositCents,
    depositLabel: formatAmountForCustomer(depositCents, tr.currency, "it"),
    founderDetails: text.details,
    customerPreview: preview.body,
    customerPreviewWithTitle: text.customerPreview,
  };
}

function depositButtons(bookingId: string): FounderButton[] {
  return [{ id: encodeDepositButtonId(bookingId), title: DEPOSIT_BUTTON_TITLE }];
}

async function notifyDepositPending(tenantId: string, tr: TransferRequest, booking: Booking): Promise<void> {
  try {
    const client = await getClient(tenantId, tr.clientId);
    if (!client || booking.finalAmountCents === null || booking.depositAmountCents === null) return;
    await sendToFounder(tenantId, {
      parts: [
        buildDepositPendingText({
          tr,
          client,
          totalCents: booking.finalAmountCents,
          depositCents: booking.depositAmountCents,
          currency: booking.currency,
        }),
      ],
      buttons: depositButtons(booking.id),
      link: linkTo(`/customers/${booking.clientId}`, FOUNDER_TEXTS.openBookingLink),
      emailSubject: `IN ATTESA DI ACCONTO ${shortRef(tr.id)}`,
    });
  } catch (error) {
    captureException(error, "quote_approval.deposit_pending_notification_failed", { bookingId: booking.id });
  }
}

// ── Decisions (admin panel and, if configured, WhatsApp buttons) ─────────

export type DecisionOutcome = "done" | "already" | "refused" | "error";

export interface DecisionResult {
  outcome: DecisionOutcome;
  // Italian, shown as-is to the founder (panel banner or WhatsApp reply).
  message: string;
  // Modifica: the new round to open.
  newRoundId?: string;
}

function settledResult(row: QuoteApprovalRequest): DecisionResult {
  const ref = shortRef(row.transferRequestId);
  switch (row.status) {
    case "approved":
      return { outcome: "already", message: FOUNDER_TEXTS.alreadyApproved(ref) };
    case "rejected":
      return { outcome: "already", message: FOUNDER_TEXTS.alreadyRejected(ref) };
    case "processing":
      return { outcome: "already", message: FOUNDER_TEXTS.inProgress(ref) };
    default:
      return { outcome: "refused", message: FOUNDER_TEXTS.superseded(ref) };
  }
}

async function loadQuoteRound(tenantId: string, roundId: string): Promise<QuoteApprovalRequest | DecisionResult> {
  if (!isQuoteApprovalEnabled()) return { outcome: "refused", message: FOUNDER_TEXTS.disabled };
  const row = await repo.getApprovalRequest(tenantId, roundId);
  if (!row || row.kind !== "quote_ready") return { outcome: "refused", message: FOUNDER_TEXTS.notFound };
  return row;
}

function isResult(value: QuoteApprovalRequest | DecisionResult): value is DecisionResult {
  return "outcome" in value;
}

async function claimRound(tenantId: string, row: QuoteApprovalRequest): Promise<QuoteApprovalRequest | DecisionResult> {
  const claimed = await repo.transitionApprovalRequest(
    tenantId,
    row.id,
    ["awaiting_decision", "awaiting_price"],
    "processing",
    {},
    { reclaimStaleProcessing: true },
  );
  if (claimed) return claimed;
  return settledResult((await repo.getApprovalRequest(tenantId, row.id)) ?? row);
}

async function releaseClaim(tenantId: string, row: QuoteApprovalRequest, error: string): Promise<void> {
  await repo.transitionApprovalRequest(tenantId, row.id, ["processing"], "awaiting_decision", { decisionError: error });
}

// Approva: approve the request at this round's price and deposit, create
// the booking waiting for the deposit, send the quote to the customer. The
// conditional claim makes a double click harmless: the second one gets
// "già approvato" and sends nothing.
export async function approveQuoteRound(
  tenantId: string,
  roundId: string,
  approverProfileId: string,
): Promise<DecisionResult> {
  const loaded = await loadQuoteRound(tenantId, roundId);
  if (isResult(loaded)) return loaded;
  const claimed = await claimRound(tenantId, loaded);
  if (isResult(claimed)) return claimed;
  const row = claimed;
  const ref = shortRef(row.transferRequestId);

  const tr = await getTransferRequest(tenantId, row.transferRequestId);
  if (!tr || (tr.status !== "pending_admin_approval" && tr.status !== "approved")) {
    await repo.transitionApprovalRequest(tenantId, row.id, ["processing"], "superseded");
    return { outcome: "refused", message: FOUNDER_TEXTS.noLongerPending(ref, tr?.status ?? "non trovato") };
  }

  const expectedAmount = row.proposedAmountCents ?? tr.calculatedAmountCents;
  if (expectedAmount === null) {
    await releaseClaim(tenantId, row, "no price");
    return { outcome: "error", message: FOUNDER_TEXTS.error(ref, "nessun prezzo sul preventivo") };
  }
  const expectedDeposit = depositForRound(row, expectedAmount);
  if (tr.status === "approved") {
    // Approved elsewhere (or a retry): never send the customer a price or
    // deposit the founder didn't see here.
    const existingBooking = await getBookingByTransferRequestId(tenantId, tr.id);
    if (
      tr.finalAmountCents !== expectedAmount ||
      (existingBooking && existingBooking.depositAmountCents !== expectedDeposit)
    ) {
      await repo.transitionApprovalRequest(tenantId, row.id, ["processing"], "superseded");
      return { outcome: "refused", message: FOUNDER_TEXTS.priceMismatch(ref) };
    }
  }

  // Checked BEFORE approving: in test mode a customer outside
  // QUOTE_APPROVAL_TEST_PHONES must not end up with an approved request
  // (and a booking) that nobody sends.
  const to = await getLastInboundWhatsappPhoneE164(tenantId, tr.clientId);
  if (!to) {
    await releaseClaim(tenantId, row, "no customer WhatsApp number");
    return { outcome: "error", message: FOUNDER_TEXTS.error(ref, "nessun numero WhatsApp del cliente trovato") };
  }
  if (!isCustomerPhoneAllowed(to)) {
    await releaseClaim(tenantId, row, "customer not in QUOTE_APPROVAL_TEST_PHONES");
    return { outcome: "refused", message: FOUNDER_TEXTS.notATestPhone(ref) };
  }

  let approved: TransferRequest;
  let booking: Booking;
  let sent: ExecutionResult;
  try {
    if (tr.status === "approved") {
      // A retry after a failure further down: ACCEPT is the documented
      // idempotent way to reconcile an already-approved request.
      approved = await acceptTransferRequest(tenantId, tr.id, approverProfileId, expectedDeposit);
    } else if (row.proposedAmountCents !== null) {
      approved = await modifyPriceForTransferRequest(
        tenantId,
        tr.id,
        approverProfileId,
        row.proposedAmountCents,
        tr.calculatedAmountCents === null ? "Prezzo inserito a mano dal titolare" : "Prezzo modificato dal titolare",
        expectedDeposit,
      );
    } else {
      approved = await acceptTransferRequest(tenantId, tr.id, approverProfileId, expectedDeposit);
    }

    if (approved.finalAmountCents === null) {
      throw new Error("approved transfer_request has no final_amount_cents");
    }
    // The booking is the record of the deposit actually requested.
    const created = await getBookingByTransferRequestId(tenantId, approved.id);
    if (!created || created.depositAmountCents === null) {
      throw new Error("prenotazione non creata");
    }
    booking = created;
    const prepared = await prepareTransferQuoteOfferCommunication({
      tenantId,
      clientId: approved.clientId,
      dealId: approved.dealId,
      transferRequestId: approved.id,
      quoteId: approved.quoteId,
      content: buildCustomerQuoteContent(approved, approved.finalAmountCents, created.depositAmountCents, to),
    });
    await submitCommunicationForApproval(tenantId, prepared.id);
    await approveCommunication(tenantId, prepared.id, approverProfileId);
    sent = await executeCommunicationDetailed(tenantId, prepared.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    captureException(error, "quote_approval.approve_failed", { transferRequestId: tr.id });
    await releaseClaim(tenantId, row, message);
    return { outcome: "error", message: FOUNDER_TEXTS.error(ref, message) };
  }

  const communication = sent.communication;
  await repo.transitionApprovalRequest(tenantId, row.id, ["processing"], "approved", {
    decidedAt: new Date(),
    customerCommunicationId: communication.id,
    decisionError: communication.status === "execution_failed" ? communication.error : null,
  });
  await alertIfCustomerSendFailed(tenantId, approved, sent, "il preventivo");
  await notifyDepositPending(tenantId, approved, booking);

  const deposit = formatAmountForCustomer(booking.depositAmountCents ?? 0, booking.currency, "it");
  if (communication.status === "executed" || communication.status === "verified") {
    return { outcome: "done", message: FOUNDER_TEXTS.approvedSent(ref, deposit) };
  }
  if (communication.status === "execution_failed") {
    return {
      outcome: "done",
      message: FOUNDER_TEXTS.approvedSendFailed(ref, communication.error ?? "errore sconosciuto", deposit),
    };
  }
  return { outcome: "done", message: FOUNDER_TEXTS.approvedSendInProgress(ref) };
}

// Rifiuta: nothing is ever sent to the customer.
export async function rejectQuoteRound(tenantId: string, roundId: string): Promise<DecisionResult> {
  const loaded = await loadQuoteRound(tenantId, roundId);
  if (isResult(loaded)) return loaded;
  const claimed = await claimRound(tenantId, loaded);
  if (isResult(claimed)) return claimed;
  const row = claimed;
  const ref = shortRef(row.transferRequestId);

  try {
    await rejectTransferRequest(tenantId, row.transferRequestId, "dal titolare");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const tr = await getTransferRequest(tenantId, row.transferRequestId);
    if (tr && tr.status !== "pending_admin_approval") {
      await repo.transitionApprovalRequest(tenantId, row.id, ["processing"], "superseded");
      return { outcome: "refused", message: FOUNDER_TEXTS.noLongerPending(ref, tr.status) };
    }
    await releaseClaim(tenantId, row, message);
    return { outcome: "error", message: FOUNDER_TEXTS.error(ref, message) };
  }

  await repo.transitionApprovalRequest(tenantId, row.id, ["processing"], "rejected", { decidedAt: new Date() });
  return { outcome: "done", message: FOUNDER_TEXTS.rejected(ref) };
}

// Modifica: this round becomes superseded and a new round opens at the new
// price (and deposit: null = 50% rule on the new price). Nothing is sent to
// the customer; the new round needs its own Approva. `notify` re-sends
// PREVENTIVO PRONTO (WhatsApp path); the panel shows the new round directly.
export async function reviseQuoteRound(
  tenantId: string,
  roundId: string,
  amountCents: number,
  depositCents: number | null,
  options: { notify: boolean },
): Promise<DecisionResult> {
  const loaded = await loadQuoteRound(tenantId, roundId);
  if (isResult(loaded)) return loaded;
  const row = loaded;
  const ref = shortRef(row.transferRequestId);

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { outcome: "refused", message: FOUNDER_TEXTS.invalidPrice };
  }
  if (depositCents !== null && !isValidDeposit(depositCents, amountCents)) {
    return { outcome: "refused", message: FOUNDER_TEXTS.invalidDeposit(ref) };
  }

  const tr = await getTransferRequest(tenantId, row.transferRequestId);
  if (!tr || tr.status !== "pending_admin_approval") {
    await repo.transitionApprovalRequest(tenantId, row.id, ["awaiting_decision", "awaiting_price"], "superseded");
    return { outcome: "refused", message: FOUNDER_TEXTS.noLongerPending(ref, tr?.status ?? "non trovato") };
  }

  const superseded = await repo.transitionApprovalRequest(
    tenantId,
    row.id,
    ["awaiting_decision", "awaiting_price"],
    "superseded",
  );
  if (!superseded) {
    return settledResult((await repo.getApprovalRequest(tenantId, row.id)) ?? row);
  }

  const next = await repo.insertApprovalRequestOnce({
    tenantId,
    transferRequestId: tr.id,
    clientId: tr.clientId,
    kind: "quote_ready",
    round: row.round + 1,
    status: "awaiting_decision",
    proposedAmountCents: amountCents,
    proposedDepositCents: depositCents,
  });
  if (!next) {
    return { outcome: "error", message: FOUNDER_TEXTS.error(ref, "impossibile creare il nuovo preventivo") };
  }

  // From the panel the founder is looking at the new round already: no
  // email for it (its notification stays 'pending', never claimed).
  if (options.notify && (await repo.claimNotification(tenantId, next.id))) {
    await deliverNotification(tenantId, next, tr);
  }

  return {
    outcome: "done",
    message: FOUNDER_TEXTS.revised(ref, formatAmountForCustomer(amountCents, tr.currency, "it")),
    newRoundId: next.id,
  };
}

// Acconto ricevuto: pending_deposit -> confirmed, then the automatic
// confirmation to the customer. A double click or a retry never sends
// twice: the booking transition is conditional, the confirmation has its
// own idempotency key plus executeCommunication's claim. A click on an
// already-confirmed booking only re-attempts a confirmation that was never
// created (e.g. a crash right after the first click).
export async function confirmDepositReceived(
  tenantId: string,
  bookingId: string,
  receivedAmountCents?: number,
): Promise<DecisionResult> {
  if (!isQuoteApprovalEnabled()) return { outcome: "refused", message: FOUNDER_TEXTS.disabled };
  const existing = await getBooking(tenantId, bookingId);
  if (!existing || !existing.transferRequestId) {
    return { outcome: "refused", message: FOUNDER_TEXTS.bookingNotFound };
  }
  const ref = shortRef(existing.transferRequestId);

  const to = await getLastInboundWhatsappPhoneE164(tenantId, existing.clientId);
  if (!to || !isCustomerPhoneAllowed(to)) {
    return { outcome: "refused", message: FOUNDER_TEXTS.notATestPhone(ref) };
  }

  try {
    const result = await confirmBookingDeposit(tenantId, bookingId, receivedAmountCents);
    if (!result) return { outcome: "refused", message: FOUNDER_TEXTS.bookingNotFound };
    const booking = result.booking;
    if (booking.status !== "confirmed") {
      return { outcome: "refused", message: FOUNDER_TEXTS.bookingNotConfirmable(ref, booking.status) };
    }

    const tr = await getTransferRequest(tenantId, existing.transferRequestId);
    if (!tr || booking.finalAmountCents === null || booking.depositAmountCents === null) {
      throw new Error("dati della prenotazione incompleti per la conferma al cliente");
    }
    const sent = await sendBookingConfirmation({
      tenantId,
      clientId: booking.clientId,
      dealId: booking.dealId,
      transferRequestId: booking.transferRequestId,
      bookingId: booking.id,
      content: buildBookingConfirmationContent({
        ...tripDetails(tr),
        to,
        balanceCents: booking.finalAmountCents - booking.depositAmountCents,
        currency: booking.currency,
      }),
    });
    await alertIfCustomerSendFailed(tenantId, tr, sent, "la conferma della prenotazione");

    const communication = sent.communication;
    const outcome: DecisionOutcome = result.changed ? "done" : "already";
    const prefix = result.changed ? "" : `${FOUNDER_TEXTS.depositAlreadyConfirmed(ref)}\n`;
    if (communication.status === "executed" || communication.status === "verified") {
      return { outcome, message: prefix + FOUNDER_TEXTS.depositConfirmedSent(ref) };
    }
    if (communication.status === "execution_failed") {
      return {
        outcome,
        message: prefix + FOUNDER_TEXTS.depositConfirmedSendFailed(ref, communication.error ?? "errore sconosciuto"),
      };
    }
    return { outcome, message: prefix + FOUNDER_TEXTS.depositConfirmedSendInProgress(ref) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    captureException(error, "quote_approval.deposit_received_failed", { bookingId });
    return { outcome: "error", message: FOUNDER_TEXTS.error(ref, message) };
  }
}

// Crea preventivo ("Prezzo da inserire", founder decision 2026-09-25): the
// founder types a price (and optionally the deposit; null = 50% rule) for
// a request the engine could not price. The
// "PREZZO DA INSERIRE" row is closed, the request moves to
// pending_admin_approval and a normal PREVENTIVO PRONTO round opens at that
// price, to be approved, modified or rejected like any other. Nothing is
// sent to the customer here. A double click: the second one finds the row
// already closed and is taken to the round the first one created.
export async function enterManualPrice(
  tenantId: string,
  manualRowId: string,
  amountCents: number,
  depositCents: number | null,
  enteredByProfileId: string,
): Promise<DecisionResult> {
  if (!isQuoteApprovalEnabled()) return { outcome: "refused", message: FOUNDER_TEXTS.disabled };
  const row = await repo.getApprovalRequest(tenantId, manualRowId);
  if (!row || row.kind !== "manual_price_required") return { outcome: "refused", message: FOUNDER_TEXTS.notFound };
  const ref = shortRef(row.transferRequestId);

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { outcome: "refused", message: FOUNDER_TEXTS.invalidPrice };
  }
  if (depositCents !== null && !isValidDeposit(depositCents, amountCents)) {
    return { outcome: "refused", message: FOUNDER_TEXTS.invalidDeposit(ref) };
  }

  const tr = await getTransferRequest(tenantId, row.transferRequestId);
  if (!tr) return { outcome: "refused", message: FOUNDER_TEXTS.notFound };
  if (!(await customerAllowed(tenantId, tr.clientId))) {
    return { outcome: "refused", message: FOUNDER_TEXTS.notATestPhone(ref) };
  }

  const claimed = await repo.transitionApprovalRequest(tenantId, row.id, ["info"], "superseded", {
    decidedAt: new Date(),
  });
  if (!claimed) {
    const existingRound = await findOpenQuoteRound(tenantId, tr.id);
    return existingRound
      ? { outcome: "already", message: FOUNDER_TEXTS.manualPriceAlreadyCreated(ref), newRoundId: existingRound.id }
      : { outcome: "refused", message: FOUNDER_TEXTS.manualPriceNoLongerNeeded(ref, tr.status) };
  }

  const moved = await enterManualPriceForTransferRequest(tenantId, tr.id, amountCents, enteredByProfileId);
  if (!moved) {
    const current = await getTransferRequest(tenantId, tr.id);
    return { outcome: "refused", message: FOUNDER_TEXTS.manualPriceNoLongerNeeded(ref, current?.status ?? "non trovato") };
  }

  const round =
    (await repo.insertApprovalRequestOnce({
      tenantId,
      transferRequestId: tr.id,
      clientId: tr.clientId,
      kind: "quote_ready",
      round: 1,
      status: "awaiting_decision",
      proposedAmountCents: amountCents,
      proposedDepositCents: depositCents,
    })) ?? (await findOpenQuoteRound(tenantId, tr.id));
  if (!round) {
    return { outcome: "error", message: FOUNDER_TEXTS.error(ref, "impossibile creare il preventivo") };
  }

  return {
    outcome: "done",
    message: FOUNDER_TEXTS.manualPriceCreated(ref, formatAmountForCustomer(amountCents, tr.currency, "it")),
    newRoundId: round.id,
  };
}

async function findOpenQuoteRound(tenantId: string, transferRequestId: string): Promise<QuoteApprovalRequest | null> {
  const rows = await repo.listApprovalRequestsByStatus(tenantId, ["awaiting_decision", "awaiting_price", "processing"]);
  return rows.find((r) => r.transferRequestId === transferRequestId && r.kind === "quote_ready") ?? null;
}

// ── Admin panel queries ──────────────────────────────────────────────────

export interface PanelRound {
  round: QuoteApprovalRequest;
  transferRequest: TransferRequest;
  client: Client;
  view: RoundView;
  ref: string;
}

export interface PanelManualPrice {
  round: QuoteApprovalRequest;
  transferRequest: TransferRequest;
  client: Client;
  text: string;
  ref: string;
}

export interface PanelPendingDeposit {
  booking: Booking;
  transferRequest: TransferRequest;
  client: Client;
  depositLabel: string;
  totalLabel: string;
  ref: string;
}

export interface PanelPending {
  enabled: boolean;
  quotes: PanelRound[];
  manualPrices: PanelManualPrice[];
  pendingDeposits: PanelPendingDeposit[];
}

async function customerAllowed(tenantId: string, clientId: string): Promise<boolean> {
  const phone = await getLastInboundWhatsappPhoneE164(tenantId, clientId);
  return phone !== null && isCustomerPhoneAllowed(phone);
}

export async function listPendingForPanel(tenantId: string): Promise<PanelPending> {
  if (!isQuoteApprovalEnabled()) return { enabled: false, quotes: [], manualPrices: [], pendingDeposits: [] };

  const quotes: PanelRound[] = [];
  const rows = await repo.listApprovalRequestsByStatus(tenantId, ["awaiting_decision", "awaiting_price", "processing"]);
  for (const row of rows) {
    if (row.kind !== "quote_ready") continue;
    const tr = await getTransferRequest(tenantId, row.transferRequestId);
    if (!tr || tr.status !== "pending_admin_approval") continue;
    if (!(await customerAllowed(tenantId, tr.clientId))) continue;
    const client = await getClient(tenantId, tr.clientId);
    if (!client) continue;
    const view = buildRoundView(row, tr, client);
    if (view) quotes.push({ round: row, transferRequest: tr, client, view, ref: shortRef(tr.id) });
  }

  const manualPrices: PanelManualPrice[] = [];
  for (const row of await repo.listApprovalRequestsByStatus(tenantId, ["info"])) {
    if (row.kind !== "manual_price_required") continue;
    const tr = await getTransferRequest(tenantId, row.transferRequestId);
    if (!tr || tr.status !== "ready_for_pricing" || tr.pricingStatus !== "manual_required") continue;
    if (!(await customerAllowed(tenantId, tr.clientId))) continue;
    const client = await getClient(tenantId, tr.clientId);
    if (!client) continue;
    manualPrices.push({ round: row, transferRequest: tr, client, text: buildManualPriceText(tr, client), ref: shortRef(tr.id) });
  }

  const pendingDeposits: PanelPendingDeposit[] = [];
  for (const booking of await listPendingDepositBookings(tenantId)) {
    if (!booking.transferRequestId) continue;
    if (!(await customerAllowed(tenantId, booking.clientId))) continue;
    const tr = await getTransferRequest(tenantId, booking.transferRequestId);
    const client = await getClient(tenantId, booking.clientId);
    if (!tr || !client) continue;
    pendingDeposits.push({
      booking,
      transferRequest: tr,
      client,
      depositLabel: formatAmountForCustomer(booking.depositAmountCents ?? 0, booking.currency, "it"),
      totalLabel: formatAmountForCustomer(booking.finalAmountCents ?? 0, booking.currency, "it"),
      ref: shortRef(tr.id),
    });
  }

  return { enabled: true, quotes, manualPrices, pendingDeposits };
}

export interface PanelRoundDetail extends PanelRound {
  // false once decided or superseded: the page then shows the outcome
  // instead of the buttons.
  open: boolean;
  // When this round was superseded by a Modifica: the newest open round.
  latestOpenRoundId: string | null;
}

export async function getRoundForPanel(tenantId: string, roundId: string): Promise<PanelRoundDetail | null> {
  const row = await repo.getApprovalRequest(tenantId, roundId);
  if (!row || row.kind !== "quote_ready") return null;
  const tr = await getTransferRequest(tenantId, row.transferRequestId);
  if (!tr) return null;
  const client = await getClient(tenantId, tr.clientId);
  if (!client) return null;
  const view = buildRoundView(row, tr, client);
  if (!view) return null;

  const open =
    (row.status === "awaiting_decision" || row.status === "awaiting_price") && tr.status === "pending_admin_approval";
  let latestOpenRoundId: string | null = null;
  if (row.status === "superseded") {
    const openRows = await repo.listApprovalRequestsByStatus(tenantId, ["awaiting_decision", "awaiting_price"]);
    latestOpenRoundId = openRows.find((r) => r.transferRequestId === tr.id && r.kind === "quote_ready")?.id ?? null;
  }

  return { round: row, transferRequest: tr, client, view, ref: shortRef(tr.id), open, latestOpenRoundId };
}

// ── WhatsApp founder commands (only when FOUNDER_WHATSAPP_PHONE is set) ──

export interface FounderInboundMessage {
  waMessageId: string;
  type: string;
  rawText: string | null;
  buttonId?: string;
  receivedAt: Date;
}

async function reply(tenantId: string, text: string, buttons?: FounderButton[]): Promise<void> {
  await sendToFounder(tenantId, { parts: [text], buttons, emailSubject: "BOS — risposta al tuo comando WhatsApp" });
}

function getFounderProfileId(): string | null {
  const id = process.env.FOUNDER_PROFILE_ID?.trim();
  return id ? id : null;
}

// Entry point for every message from FOUNDER_WHATSAPP_PHONE. These never go
// through client matching or transfer_requests.
export async function handleFounderMessage(message: FounderInboundMessage): Promise<void> {
  if (!isQuoteApprovalEnabled()) return;
  const tenantId = await repo.getDefaultTenantId();
  const isNew = await repo.recordFounderMessage(tenantId, message);
  if (!isNew) return;

  if (message.buttonId) {
    const depositBookingId = decodeDepositButtonId(message.buttonId);
    if (depositBookingId) {
      await reply(tenantId, (await confirmDepositReceived(tenantId, depositBookingId)).message);
      return;
    }
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
      const parsed = parseFounderPriceAndDeposit(text);
      if (parsed) {
        const result = await reviseQuoteRound(tenantId, awaitingPrice.id, parsed.amountCents, parsed.depositCents, {
          notify: true,
        });
        if (result.outcome !== "done") await reply(tenantId, result.message);
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
    if (!(await customerAllowed(tenantId, tr.clientId))) continue;
    if (row.status === "awaiting_price") {
      await reply(tenantId, FOUNDER_TEXTS.awaitingPriceReminder(shortRef(tr.id)));
    } else {
      await deliverNotification(tenantId, row, tr);
    }
    sent++;
  }

  // Bookings created by an approval still waiting for their deposit.
  for (const booking of await listPendingDepositBookings(tenantId)) {
    if (!booking.transferRequestId) continue;
    if (!(await customerAllowed(tenantId, booking.clientId))) continue;
    const deposit = formatAmountForCustomer(booking.depositAmountCents ?? 0, booking.currency, "it");
    await reply(tenantId, FOUNDER_TEXTS.depositPending(shortRef(booking.transferRequestId), deposit), depositButtons(booking.id));
    sent++;
  }

  if (sent === 0) {
    await reply(tenantId, FOUNDER_TEXTS.nothingPending);
  }
}

async function handleButton(tenantId: string, approvalRequestId: string, action: ApprovalAction): Promise<void> {
  if (action === "modify") {
    await handleModifyButton(tenantId, approvalRequestId);
    return;
  }

  if (action === "approve") {
    const founderProfileId = getFounderProfileId();
    if (!founderProfileId || !(await repo.isAdminProfile(tenantId, founderProfileId))) {
      await reply(tenantId, FOUNDER_TEXTS.configError("FOUNDER_PROFILE_ID (deve essere il tuo profilo admin)"));
      return;
    }
    await reply(tenantId, (await approveQuoteRound(tenantId, approvalRequestId, founderProfileId)).message);
    return;
  }

  await reply(tenantId, (await rejectQuoteRound(tenantId, approvalRequestId)).message);
}

// WhatsApp Modifica is two steps (tap, then type the price); the panel does
// it in one. Only one round per tenant may wait for a typed price, so a bare
// "280" is never ambiguous.
async function handleModifyButton(tenantId: string, approvalRequestId: string): Promise<void> {
  const row = await repo.getApprovalRequest(tenantId, approvalRequestId);
  if (!row || row.kind !== "quote_ready") {
    await reply(tenantId, FOUNDER_TEXTS.notFound);
    return;
  }
  const ref = shortRef(row.transferRequestId);
  if (row.status === "awaiting_price") {
    await reply(tenantId, FOUNDER_TEXTS.askPrice(ref));
    return;
  }
  if (row.status !== "awaiting_decision") {
    await reply(tenantId, settledResult(row).message);
    return;
  }

  for (const other of await repo.listApprovalRequestsByStatus(tenantId, ["awaiting_price"])) {
    if (other.id !== row.id) {
      await repo.transitionApprovalRequest(tenantId, other.id, ["awaiting_price"], "awaiting_decision");
    }
  }

  const updated = await repo.transitionApprovalRequest(tenantId, row.id, ["awaiting_decision"], "awaiting_price");
  if (!updated) {
    await reply(tenantId, settledResult((await repo.getApprovalRequest(tenantId, row.id)) ?? row).message);
    return;
  }
  await reply(tenantId, FOUNDER_TEXTS.askPrice(ref));
}
