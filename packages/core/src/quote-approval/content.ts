import type { TransferRequest, Client } from "@bos/db";
import { formatAmountForCustomer, formatDateForCustomer } from "../communications";

// Founder-facing texts (Italian, fixed wording) and the parsing of the
// founder's replies. Pure functions only — no I/O.

export type ApprovalAction = "approve" | "modify" | "reject";

const ACTIONS: readonly ApprovalAction[] = ["approve", "modify", "reject"];

export const APPROVAL_BUTTONS: ReadonlyArray<{ action: ApprovalAction; title: string }> = [
  { action: "approve", title: "APPROVA" },
  { action: "modify", title: "MODIFICA" },
  { action: "reject", title: "RIFIUTA" },
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The button id names one specific approval round, so a tap always acts on
// the exact quote (and price) shown in the message it belongs to.
export function encodeButtonId(approvalRequestId: string, action: ApprovalAction): string {
  return `qa:${approvalRequestId}:${action}`;
}

export function decodeButtonId(buttonId: string): { approvalRequestId: string; action: ApprovalAction } | null {
  const [prefix, id, action, ...rest] = buttonId.split(":");
  if (prefix !== "qa" || !id || !action || rest.length > 0) return null;
  if (!UUID_PATTERN.test(id)) return null;
  if (!ACTIONS.includes(action as ApprovalAction)) return null;
  return { approvalRequestId: id, action: action as ApprovalAction };
}

// Accepts "280", "280€", "€ 280", "280,50", "280.50", "280 euro". Anything
// else (thousand separators, words, several numbers) is rejected rather
// than guessed.
export function parseFounderPrice(text: string): number | null {
  const match = /^\s*€?\s*(\d{1,5})(?:[.,](\d{1,2}))?\s*(?:€|eur|euro)?\s*$/i.exec(text);
  if (!match) return null;
  const euros = Number(match[1]);
  const decimals = match[2] ? Number(match[2].padEnd(2, "0")) : 0;
  const cents = euros * 100 + decimals;
  return cents > 0 ? cents : null;
}

// MODIFICA reply: "280" (deposit recomputed) or "280 100" (price and
// deposit). Each number follows parseFounderPrice's format.
export function parseFounderPriceAndDeposit(
  text: string,
): { amountCents: number; depositCents: number | null } | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length === 1) {
    const amountCents = parseFounderPrice(parts[0]!);
    return amountCents === null ? null : { amountCents, depositCents: null };
  }
  if (parts.length === 2) {
    const amountCents = parseFounderPrice(parts[0]!);
    const depositCents = parseFounderPrice(parts[1]!);
    return amountCents === null || depositCents === null ? null : { amountCents, depositCents };
  }
  return null;
}

// "bk:<booking id>:deposit_received" — names the exact booking, like the
// approval buttons name the exact round.
export function encodeDepositButtonId(bookingId: string): string {
  return `bk:${bookingId}:deposit_received`;
}

export function decodeDepositButtonId(buttonId: string): string | null {
  const [prefix, id, action, ...rest] = buttonId.split(":");
  if (prefix !== "bk" || action !== "deposit_received" || !id || rest.length > 0) return null;
  return UUID_PATTERN.test(id) ? id : null;
}

export const DEPOSIT_BUTTON_TITLE = "ACCONTO RICEVUTO";

export function isTypedCommand(text: string): boolean {
  return /^\s*(approva|modifica|rifiuta)\b/i.test(text);
}

export function shortRef(transferRequestId: string): string {
  return `#${transferRequestId.slice(0, 6)}`;
}

function formatEuro(amountCents: number, currency: string): string {
  return formatAmountForCustomer(amountCents, currency, "it");
}

function displayPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  return digits ? `+${digits}` : phone;
}

function childrenLine(tr: TransferRequest): string {
  if (tr.children === null) return "non indicato";
  if (tr.children === 0) return "nessuno";
  return tr.childrenAges ? `${tr.children} (età: ${tr.childrenAges})` : `${tr.children} (età non indicata)`;
}

function availabilityLine(breakdown: unknown): string {
  if (!breakdown || typeof breakdown !== "object") return "non verificata";
  const value = breakdown as { status?: unknown; feasibility?: { feasible?: unknown } | null };
  if (value.status !== "verified") return "non verificata (percorso non calcolato)";
  if (value.feasibility?.feasible === true) return "compatibile con gli altri servizi";
  if (value.feasibility?.feasible === false) return "ATTENZIONE: margine operativo insufficiente";
  return "non verificata";
}

function pricingLabel(tr: TransferRequest): string {
  if (tr.pricingStatus === "fixed") return "tariffa fissa";
  if (tr.pricingStatus === "calculated_km") return "calcolato a km";
  return tr.pricingStatus;
}

function tripLines(tr: TransferRequest, client: Client): string[] {
  const lines = [
    `Cliente: ${client.fullName} (${displayPhone(client.phone)})`,
    `Tratta: ${tr.pickup ?? "?"} → ${tr.destination ?? "?"}`,
    `Data: ${tr.requestedDate ? formatDateForCustomer(tr.requestedDate) : "?"} ore ${tr.requestedTime ?? "?"}`,
    `Passeggeri: ${tr.passengers ?? "?"}`,
    `Bambini: ${childrenLine(tr)}`,
    `Bagagli: ${tr.luggage ?? "non indicato"}`,
  ];
  if (tr.flightNumber) lines.push(`Volo: ${tr.flightNumber}`);
  if (tr.trainNumber) lines.push(`Treno: ${tr.trainNumber}`);
  if (tr.hotel) lines.push(`Hotel: ${tr.hotel}`);
  return lines;
}

export interface QuoteReadyText {
  details: string;
  customerPreview: string;
}

export function buildQuoteReadyText(input: {
  tr: TransferRequest;
  client: Client;
  proposedAmountCents: number | null;
  depositCents: number;
  depositIsCustom: boolean;
  customerMessageBody: string;
}): QuoteReadyText {
  const { tr, client, proposedAmountCents } = input;
  const total = proposedAmountCents ?? tr.calculatedAmountCents ?? 0;
  const calculated = tr.calculatedAmountCents;
  // No calculated price + a proposed one = the founder typed it in
  // "Prezzo da inserire" (the engine could not price this request).
  const enteredByHand = proposedAmountCents !== null && calculated === null;
  const priceLine = enteredByHand
    ? `Prezzo: ${formatEuro(proposedAmountCents, tr.currency)} (inserito a mano: non calcolabile in automatico)`
    : proposedAmountCents !== null
      ? `Prezzo: ${formatEuro(proposedAmountCents, tr.currency)} (modificato da te; calcolato ${
          calculated !== null ? formatEuro(calculated, tr.currency) : "n/d"
        })`
      : `Prezzo: ${calculated !== null ? formatEuro(calculated, tr.currency) : "n/d"} (${pricingLabel(tr)})`;

  const details = [
    enteredByHand
      ? "PREVENTIVO PRONTO (prezzo inserito a mano)"
      : proposedAmountCents !== null
        ? "PREVENTIVO PRONTO (prezzo modificato)"
        : "PREVENTIVO PRONTO",
    `Rif. ${shortRef(tr.id)}`,
    "",
    ...tripLines(tr, client),
    priceLine,
    `Acconto: ${formatEuro(input.depositCents, tr.currency)}${
      input.depositIsCustom ? " (scelto da te)" : " (50%, arrotondato)"
    } — saldo all'autista ${formatEuro(total - input.depositCents, tr.currency)}`,
    `Disponibilità: ${availabilityLine(tr.availabilityBreakdown)}`,
  ].join("\n");

  return {
    details,
    customerPreview: `Messaggio che riceverà il cliente (${shortRef(tr.id)}):\n\n${input.customerMessageBody}`,
  };
}

function manualReason(breakdown: unknown): string | null {
  if (!breakdown || typeof breakdown !== "object") return null;
  const reason = (breakdown as { manualRequiredReason?: unknown }).manualRequiredReason;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}

export function buildManualPriceText(tr: TransferRequest, client: Client): string {
  const reason = manualReason(tr.pricingBreakdown);
  return [
    "PREZZO DA INSERIRE",
    `Rif. ${shortRef(tr.id)}`,
    "",
    ...tripLines(tr, client),
    "",
    `Il prezzo non si può calcolare in automatico${reason ? ` (motivo: ${reason})` : ""}.`,
    "Inserisci il prezzo nel pannello (Preventivi in attesa → Crea preventivo): poi lo approvi come gli altri. Al cliente non è stato inviato nulla.",
  ].join("\n");
}

// Alert when a message to the customer did not go out (24h window closed,
// Meta error, provider not configured). Sent once per failed send.
export function buildCustomerSendFailureText(input: {
  what: string;
  ref: string;
  clientName: string;
  clientPhone: string;
  error: string;
  body: string;
}): string {
  return [
    "INVIO AL CLIENTE NON RIUSCITO",
    `Rif. ${input.ref}`,
    "",
    `Cliente: ${input.clientName} (${displayPhone(input.clientPhone)})`,
    `Messaggio: ${input.what}`,
    `Motivo: ${input.error}`,
    "",
    "Il cliente NON ha ricevuto questo testo; contattalo a mano:",
    "",
    input.body,
  ].join("\n");
}

// Email after an approval: the booking now waits for the deposit (the
// founder sends the SumUp link and presses "Acconto ricevuto" when paid).
export function buildDepositPendingText(input: {
  tr: TransferRequest;
  client: Client;
  totalCents: number;
  depositCents: number;
  currency: string;
}): string {
  const { tr, client } = input;
  return [
    "IN ATTESA DI ACCONTO",
    `Rif. ${shortRef(tr.id)}`,
    "",
    `Cliente: ${client.fullName} (${displayPhone(client.phone)})`,
    `Tratta: ${tr.pickup ?? "?"} → ${tr.destination ?? "?"}`,
    `Data: ${tr.requestedDate ? formatDateForCustomer(tr.requestedDate) : "?"} ore ${tr.requestedTime ?? "?"}`,
    `Totale: ${formatEuro(input.totalCents, input.currency)}`,
    `Acconto da ricevere: ${formatEuro(input.depositCents, input.currency)}`,
    `Saldo all'autista: ${formatEuro(input.totalCents - input.depositCents, input.currency)}`,
    "",
    "Il preventivo è partito. Manda al cliente il link SumUp per l'acconto; quando lo ricevi premi \"Acconto ricevuto\": la prenotazione diventa confermata e il cliente riceve la conferma automatica.",
  ].join("\n");
}

export const FOUNDER_TEXTS = {
  askPrice: (ref: string) =>
    `MODIFICA ${ref}: scrivi il nuovo prezzo in euro (es. 280 — acconto calcolato al 50%) oppure prezzo e acconto (es. 280 100).`,
  awaitingPriceReminder: (ref: string) =>
    `Aspetto ancora il nuovo prezzo per ${ref}: es. 280 oppure 280 100 (prezzo e acconto).`,
  invalidDeposit: (ref: string) =>
    `${ref}: l'acconto deve essere maggiore di zero e non superiore al prezzo. Riscrivi prezzo e acconto, es. 280 100.`,
  approvedSent: (ref: string, deposit: string) =>
    `✅ ${ref} approvato. Preventivo inviato al cliente su WhatsApp (la conferma di consegna arriva a parte).
Prenotazione in attesa di acconto (${deposit}): quando lo ricevi premi "Acconto ricevuto".`,
  approvedSendFailed: (ref: string, error: string, deposit: string) =>
    `⚠️ ${ref} approvato, ma il WhatsApp al cliente NON è partito: ${error}
Contatta il cliente a mano. Prenotazione in attesa di acconto (${deposit}): quando lo ricevi premi "Acconto ricevuto".`,
  approvedSendInProgress: (ref: string) => `${ref} approvato: invio al cliente già in corso.`,
  depositPending: (ref: string, deposit: string) =>
    `IN ATTESA DI ACCONTO ${ref}: ${deposit}. Quando lo ricevi premi "Acconto ricevuto".`,
  depositConfirmedSent: (ref: string) =>
    `✅ ${ref}: acconto registrato, prenotazione CONFERMATA. Conferma consegnata a WhatsApp per l'invio al cliente.`,
  depositConfirmedSendFailed: (ref: string, error: string) =>
    `⚠️ ${ref}: acconto registrato, prenotazione CONFERMATA, ma il WhatsApp di conferma al cliente NON è partito: ${error}\nAvvisa il cliente a mano.`,
  depositConfirmedSendInProgress: (ref: string) =>
    `${ref}: prenotazione confermata, invio della conferma al cliente già in corso.`,
  depositAlreadyConfirmed: (ref: string) => `${ref}: la prenotazione era già confermata.`,
  bookingNotConfirmable: (ref: string, status: string) =>
    `${ref}: la prenotazione è in stato "${status}", non si può confermare. Nessun invio al cliente.`,
  bookingNotFound: "Prenotazione non trovata.",
  openBookingLink: "Apri la prenotazione nel pannello",
  rejected: (ref: string) => `❌ ${ref} rifiutato. Al cliente non è stato inviato nulla.`,
  alreadyApproved: (ref: string) => `${ref} è già approvato. Nessun nuovo invio al cliente.`,
  alreadyRejected: (ref: string) => `${ref} è già rifiutato.`,
  inProgress: (ref: string) => `Sto già elaborando ${ref}, attendi qualche secondo.`,
  superseded: (ref: string) =>
    `Questo preventivo ${ref} non è più valido: è stato sostituito da uno più recente. Usa l'ultimo.`,
  noLongerPending: (ref: string, status: string) =>
    `${ref} non è più in attesa di approvazione (stato: ${status}). Nessun invio al cliente.`,
  priceMismatch: (ref: string) =>
    `${ref} risulta già approvato con un prezzo diverso da questo messaggio. Nessun invio al cliente: controlla dal pannello.`,
  error: (ref: string, error: string) => `Errore su ${ref}: ${error}\nNiente è stato inviato al cliente. Puoi riprovare.`,
  notATestPhone: (ref: string) =>
    `${ref}: il cliente non è tra i numeri di prova (QUOTE_APPROVAL_TEST_PHONES). Nessuna approvazione, nessun invio.`,
  unknownButton: "Pulsante non riconosciuto. Scrivi un messaggio qualsiasi per ricevere di nuovo i preventivi in attesa.",
  notFound: "Preventivo non trovato.",
  useButtons: "I comandi valgono solo tramite i pulsanti sotto ogni PREVENTIVO PRONTO. Te li rimando qui sotto.",
  nothingPending: "Nessun preventivo in attesa di approvazione e nessuna prenotazione in attesa di acconto.",
  configError: (what: string) => `Configurazione mancante: ${what}. Nessuna azione eseguita.`,
  disabled: "Flusso preventivi disattivato (QUOTE_APPROVAL_ENABLED). Nessuna azione eseguita.",
  invalidPrice: "Prezzo non valido: scrivi un importo in euro maggiore di zero, es. 280 oppure 280,50.",
  revised: (ref: string, price: string) =>
    `Nuovo preventivo ${ref} a ${price}: controlla l'anteprima e approva. Il preventivo precedente non è più valido.`,
  noAdminLink:
    "Per decidere apri il pannello admin → Preventivi in attesa. (ADMIN_BASE_URL non è configurato, quindi manca il link diretto.)",
  manualPriceCreated: (ref: string, price: string) =>
    `Preventivo ${ref} creato a ${price}: controlla l'anteprima e approva. Al cliente non è partito nulla.`,
  manualPriceAlreadyCreated: (ref: string) => `Il preventivo per ${ref} era già stato creato: eccolo.`,
  manualPriceNoLongerNeeded: (ref: string, status: string) =>
    `${ref} non è più "prezzo da inserire" (stato: ${status}). Nessun preventivo creato.`,
  openQuoteLink: "Apri il preventivo nel pannello",
  openPendingLink: "Apri i preventivi in attesa",
  emailFooter:
    "Per usare i pulsanti (APPROVA / MODIFICA / RIFIUTA, ACCONTO RICEVUTO) scrivi un messaggio qualsiasi al numero WhatsApp aziendale: ti rimando tutto ciò che è in attesa.",
} as const;
