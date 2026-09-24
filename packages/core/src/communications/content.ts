import type { Client, Quote } from "@bos/db";
import type { CommunicationContent } from "./schema";

// Deterministic, template-based content — never an LLM call. Every value
// comes from a real, already-persisted row (client.fullName, quote.amountCents/
// currency/notes); nothing here is invented, guessed, or defaulted to a
// plausible-looking placeholder (rule 4 of the approved Phase 3 spec: no
// agent may invent a price). Mirrors bos-agent/image-generator.ts's
// briefForTheme — a fixed mapping from real data to real text, not a
// generative step.

function formatAmount(amountCents: number, currency: string): string {
  return `${(amountCents / 100).toFixed(2)} ${currency}`;
}

// Throws rather than silently building a communication with no real price
// — a quote with amountCents:null exists (the schema allows a draft quote
// with no amount yet, see packages/db/src/schema/quotes.ts), but preparing
// a customer-facing "offer" message from it would mean inventing the one
// fact this message exists to state. The caller (service.ts) surfaces this
// as a normal, expected error, not a crash to hide.
export function buildQuoteOfferContent(client: Client, quote: Quote): CommunicationContent {
  if (quote.amountCents === null) {
    throw new Error(`buildQuoteOfferContent: quote ${quote.id} has no amountCents — refusing to invent a price`);
  }

  const amount = formatAmount(quote.amountCents, quote.currency);
  const notesLine = quote.notes ? `\n\n${quote.notes}` : "";

  return {
    to: client.phone,
    templateName: "quote_offer_v1",
    body: `Ciao ${client.fullName}, ecco la nostra offerta: ${amount}.${notesLine}`,
  };
}

// ── WhatsApp quote approval flow (packages/core/src/quote-approval) ───────
// Fixed, founder-approved wording only: no LLM, no invented facts. The
// missing-information question never mentions a price. Register: private
// transfer / chauffeur service — never "taxi".

export type CustomerLanguage = "it" | "en";

// The parser reports language as free text ("it", "Italian", "italiano",
// "en", "English", "de"...). Italian or unknown -> Italian; any other
// detected language -> English, the closer fit for a foreign customer.
export function toCustomerLanguage(language: string | null | undefined): CustomerLanguage {
  if (!language) return "it";
  return /^(it|ita|italian|italiano)\b/i.test(language.trim()) ? "it" : "en";
}

export type BlockingMissingField = "pickup" | "destination" | "passengers" | "date" | "time" | "flight_number";

const BLOCKING_LABELS: Record<CustomerLanguage, Record<BlockingMissingField, string>> = {
  it: {
    pickup: "luogo di partenza",
    destination: "destinazione",
    passengers: "numero di passeggeri",
    date: "data del servizio",
    time: "orario",
    flight_number: "numero del volo",
  },
  en: {
    pickup: "pickup location",
    destination: "destination",
    passengers: "number of passengers",
    date: "date of service",
    time: "time",
    flight_number: "flight number",
  },
};

const OPTIONAL_LABELS: Record<CustomerLanguage, { children: string; childrenAges: string; luggage: string }> = {
  it: {
    children: "quanti bambini viaggiano e la loro età",
    childrenAges: "l'età dei bambini",
    luggage: "quanti bagagli avete",
  },
  en: {
    children: "how many children are travelling and their ages",
    childrenAges: "the ages of the children",
    luggage: "how many pieces of luggage you have",
  },
};

export interface MissingInfoRequestInput {
  to: string;
  language: CustomerLanguage;
  missing: string[];
  askChildren: boolean;
  askChildrenAges: boolean;
  askLuggage: boolean;
  isFollowUp: boolean;
}

export function buildMissingInfoRequestContent(input: MissingInfoRequestInput): CommunicationContent {
  const lang = input.language;
  const blocking = input.missing
    .filter((field): field is BlockingMissingField => field in BLOCKING_LABELS[lang])
    .map((field) => `- ${BLOCKING_LABELS[lang][field]}`);
  if (blocking.length === 0) {
    throw new Error("buildMissingInfoRequestContent: no known missing field to ask for");
  }

  const optional: string[] = [];
  if (input.askChildren) optional.push(`- ${OPTIONAL_LABELS[lang].children}`);
  else if (input.askChildrenAges) optional.push(`- ${OPTIONAL_LABELS[lang].childrenAges}`);
  if (input.askLuggage) optional.push(`- ${OPTIONAL_LABELS[lang].luggage}`);

  const lines: string[] =
    lang === "it"
      ? [
          input.isFollowUp
            ? "Grazie. Per completare il preventivo ci servono ancora:"
            : "Buongiorno, grazie per aver contattato Bonolini Transfer. Per preparare il preventivo ci servono ancora:",
          ...blocking,
        ]
      : [
          input.isFollowUp
            ? "Thank you. To complete your quote we still need:"
            : "Hello, thank you for contacting Bonolini Transfer. To prepare your quote we still need:",
          ...blocking,
        ];

  if (optional.length > 0) {
    lines.push("", lang === "it" ? "Se possibile, indicateci anche:" : "If possible, please also let us know:", ...optional);
  }

  return { to: input.to, templateName: `missing_info_request_${lang}_v1`, body: lines.join("\n") };
}

export function formatAmountForCustomer(amountCents: number, currency: string, language: CustomerLanguage): string {
  const value = amountCents / 100;
  if (currency === "EUR") {
    return language === "it"
      ? `${value.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
      : `€${value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${value.toFixed(2)} ${currency}`;
}

// "2026-10-03" -> "03/10/2026"; anything unexpected is shown verbatim
// rather than reinterpreted.
export function formatDateForCustomer(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : isoDate;
}

export interface TransferQuoteOfferInput {
  to: string;
  language: CustomerLanguage;
  pickup: string;
  destination: string;
  requestedDate: string;
  requestedTime: string;
  passengers: number;
  flightNumber: string | null;
  amountCents: number;
  currency: string;
}

export function buildTransferQuoteOfferContent(input: TransferQuoteOfferInput): CommunicationContent {
  const lang = input.language;
  const price = formatAmountForCustomer(input.amountCents, input.currency, lang);
  const date = formatDateForCustomer(input.requestedDate);

  const lines =
    lang === "it"
      ? [
          "Buongiorno,",
          "grazie per aver scelto Bonolini Transfer. Ecco il preventivo per il servizio richiesto:",
          "",
          `Tratta: ${input.pickup} → ${input.destination}`,
          `Data: ${date} alle ${input.requestedTime}`,
          `Passeggeri: ${input.passengers}`,
          ...(input.flightNumber ? [`Volo: ${input.flightNumber}`] : []),
          `Prezzo: ${price}`,
          "",
          "Per confermare il servizio o per qualsiasi domanda può rispondere direttamente a questo messaggio.",
        ]
      : [
          "Hello,",
          "thank you for choosing Bonolini Transfer. Here is the quote for your requested transfer:",
          "",
          `Route: ${input.pickup} → ${input.destination}`,
          `Date: ${date} at ${input.requestedTime}`,
          `Passengers: ${input.passengers}`,
          ...(input.flightNumber ? [`Flight: ${input.flightNumber}`] : []),
          `Price: ${price}`,
          "",
          "To confirm the service or for any question, simply reply to this message.",
        ];

  return { to: input.to, templateName: `transfer_quote_offer_${lang}_v1`, body: lines.join("\n") };
}
