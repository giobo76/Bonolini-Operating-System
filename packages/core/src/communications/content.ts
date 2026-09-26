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
// Texts supplied by the founder on 2026-09-24 (register "Lei"): no LLM, no
// invented facts, never the word "taxi". The missing-information question
// never mentions a price. Lines marked "derived" were not in the supplied
// texts and follow their wording.

export type CustomerLanguage = "it" | "en";

// The parser reports language as free text ("it", "Italian", "italiano",
// "en", "English", "de"...). Italian or unknown -> Italian; any other
// detected language -> English, the closer fit for a foreign customer.
export function toCustomerLanguage(language: string | null | undefined): CustomerLanguage {
  if (!language) return "it";
  return /^(it|ita|italian|italiano)\b/i.test(language.trim()) ? "it" : "en";
}

const SIGNATURE = "Bonolini Transfer – Private Transfers";

// Vehicle line for customers: deliberately no make or model (founder
// decision 2026-09-25). Not a database field:
// BOS has no vehicle model anywhere, and availability assumes one vehicle.
const VEHICLE: Record<CustomerLanguage, string> = {
  it: "minivan premium con autista privato",
  en: "premium minivan with private driver",
};

export type BlockingMissingField = "pickup" | "destination" | "passengers" | "date" | "time" | "flight_number";

// The supplied text's order, independent of the order
// computeMissingInformation reports the fields in.
const BLOCKING_ORDER: BlockingMissingField[] = ["pickup", "destination", "date", "time", "passengers", "flight_number"];

const BLOCKING_LABELS: Record<CustomerLanguage, Record<BlockingMissingField, string>> = {
  it: {
    pickup: "luogo di partenza",
    destination: "destinazione",
    date: "data del viaggio",
    time: "orario di partenza",
    passengers: "numero di passeggeri",
    flight_number: "numero del volo",
  },
  en: {
    pickup: "pickup location",
    destination: "destination",
    date: "travel date",
    time: "pickup time",
    passengers: "number of passengers",
    flight_number: "flight number",
  },
};

const OPTIONAL_LABELS: Record<CustomerLanguage, { children: string; childrenAges: string; luggage: string }> = {
  it: {
    children: "quanti bambini viaggiano e la loro età (per i seggiolini)",
    // derived: number of children known, ages missing
    childrenAges: "l'età dei bambini (per i seggiolini)",
    luggage: "quanti bagagli sono previsti (valigie grandi e bagagli a mano)",
  },
  en: {
    children: "how many children are travelling and their ages (for child seats)",
    // derived: number of children known, ages missing
    childrenAges: "the ages of the children (for child seats)",
    luggage: "how much luggage you have (large suitcases and carry-ons)",
  },
};

export interface MissingInfoRequestInput {
  to: string;
  language: CustomerLanguage;
  missing: string[];
  askChildren: boolean;
  askChildrenAges: boolean;
  askLuggage: boolean;
}

export function buildMissingInfoRequestContent(input: MissingInfoRequestInput): CommunicationContent {
  const lang = input.language;
  const blocking = BLOCKING_ORDER.filter((field) => input.missing.includes(field)).map(
    (field) => `- ${BLOCKING_LABELS[lang][field]}`,
  );
  if (blocking.length === 0) {
    throw new Error("buildMissingInfoRequestContent: no known missing field to ask for");
  }

  const optional: string[] = [];
  if (input.askChildren) optional.push(`- ${OPTIONAL_LABELS[lang].children}`);
  else if (input.askChildrenAges) optional.push(`- ${OPTIONAL_LABELS[lang].childrenAges}`);
  if (input.askLuggage) optional.push(`- ${OPTIONAL_LABELS[lang].luggage}`);

  const lines =
    lang === "it"
      ? [
          "Buongiorno e grazie per aver contattato Bonolini Transfer.",
          "Per preparare il Suo preventivo ci servono ancora:",
          ...blocking,
        ]
      : ["Hello and thank you for contacting Bonolini Transfer.", "To prepare your quote, we still need:", ...blocking];

  if (optional.length > 0) {
    lines.push("", lang === "it" ? "Se possibile, ci indichi anche:" : "If possible, please also let us know:", ...optional);
  }
  lines.push("", SIGNATURE);

  return { to: input.to, templateName: `missing_info_request_${lang}_v2`, body: lines.join("\n") };
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

// "2026-10-03" -> "03/10/2026" (founder-facing texts); anything unexpected
// is shown verbatim rather than reinterpreted.
export function formatDateForCustomer(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : isoDate;
}

// Fixed here rather than taken from Intl, whose month names depend on the
// server's ICU data.
const MONTHS: Record<CustomerLanguage, string[]> = {
  it: [
    "gennaio",
    "febbraio",
    "marzo",
    "aprile",
    "maggio",
    "giugno",
    "luglio",
    "agosto",
    "settembre",
    "ottobre",
    "novembre",
    "dicembre",
  ],
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
};

// IT "3 ottobre 2026, ore 14:30", EN "3 October 2026 at 14:30".
export function formatLongDateTime(isoDate: string, time: string, language: CustomerLanguage): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  const month = match ? MONTHS[language][Number(match[2]) - 1] : undefined;
  const date = match && month ? `${Number(match[3])} ${month} ${match[1]}` : isoDate;
  return language === "it" ? `${date}, ore ${time}` : `${date} at ${time}`;
}

// Display only: the stored value keeps whatever the customer wrote.
export function capitalizePlace(place: string): string {
  const trimmed = place.trim();
  return trimmed.charAt(0).toLocaleUpperCase("it-IT") + trimmed.slice(1);
}

function joinList(items: string[], language: CustomerLanguage): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${language === "it" ? "e" : "and"} ${items[items.length - 1]}`;
}

// childrenAges is free text as the customer wrote it ("4 e 7 anni", "4, 7").
// Reformatted only when it holds exactly one number per child; otherwise
// shown as written.
function formatChildrenAges(childrenAges: string, children: number, language: CustomerLanguage): string {
  const ages = childrenAges.match(/\d+/g) ?? [];
  if (ages.length === children) {
    if (language === "it") return `${joinList(ages, "it")} ${ages.length === 1 && ages[0] === "1" ? "anno" : "anni"}`;
    return `${ages.length === 1 ? "age" : "ages"} ${joinList(ages, "en")}`;
  }
  return language === "it" ? `età: ${childrenAges}` : `ages: ${childrenAges}`;
}

// `passengers` is the total number of people (the parser is told so).
// "2 adulti + 2 bambini" only when that split is consistent; otherwise the
// plain total, never a guessed split.
export function formatPassengers(
  passengers: number,
  children: number | null,
  childrenAges: string | null,
  language: CustomerLanguage,
): string {
  if (!children || children <= 0 || children >= passengers) return String(passengers);
  const adults = passengers - children;
  const ages = childrenAges ? ` (${formatChildrenAges(childrenAges, children, language)})` : "";
  if (language === "it") {
    return `${adults} ${adults === 1 ? "adulto" : "adulti"} + ${children} ${children === 1 ? "bambino" : "bambini"}${ages}`;
  }
  return `${adults} ${adults === 1 ? "adult" : "adults"} + ${children} ${children === 1 ? "child" : "children"}${ages}`;
}

// ── Deposit texts ─────────────────────────────────────────────────────────
// Founder's final wording (2026-09-24). The amounts are the real values of
// each quote/booking.

const DEPOSIT_LINES: Record<
  CustomerLanguage,
  {
    total: (v: string) => string;
    deposit: (v: string) => string;
    balance: (v: string) => string;
    paymentLink: string;
    driverDetails: string;
  }
> = {
  it: {
    total: (v) => `Prezzo totale: ${v} per l'intero veicolo`,
    deposit: (v) => `Acconto per confermare la prenotazione: ${v}`,
    balance: (v) => `Saldo all'autista il giorno del servizio: ${v} (preferibilmente in contanti)`,
    paymentLink: "Se il preventivo Le va bene, Le invieremo il link per il pagamento dell'acconto.",
    driverDetails: "Il giorno prima del servizio Le invieremo nome e contatto dell'autista.",
  },
  en: {
    total: (v) => `Total price: ${v} for the entire vehicle`,
    deposit: (v) => `Deposit to confirm the booking: ${v}`,
    balance: (v) => `Balance to the driver on the day of service: ${v} (preferably in cash)`,
    paymentLink: "If the quote works for you, we will send you the link to pay the deposit.",
    driverDetails: "The day before your transfer we will send you the driver's name and contact details.",
  },
};

// Italian customers (+39) never pay a deposit (founder decision 2026-09-26):
// the quote keeps the pre-deposit wording, the confirmation says how to pay.
const NO_DEPOSIT_LINES: Record<
  CustomerLanguage,
  { price: (v: string) => string; confirmed: string; payment: string }
> = {
  it: {
    price: (v) => `Prezzo: ${v} per l'intero veicolo`,
    confirmed: "Le confermiamo la prenotazione con Bonolini Transfer.",
    payment: "Pagamento all'autista il giorno del servizio, in contanti o con carta.",
  },
  en: {
    price: (v) => `Price: ${v} for the entire vehicle`,
    confirmed: "Your booking with Bonolini Transfer is confirmed.",
    payment: "Payment to the driver on the day of service, in cash or by card.",
  },
};

interface TripDetails {
  language: CustomerLanguage;
  pickup: string;
  destination: string;
  requestedDate: string;
  requestedTime: string;
  passengers: number;
  children: number | null;
  childrenAges: string | null;
  luggage: string | null;
  flightNumber: string | null;
}

function tripLines(input: TripDetails): string[] {
  const lang = input.language;
  const route = `${capitalizePlace(input.pickup)} → ${capitalizePlace(input.destination)}`;
  const when = formatLongDateTime(input.requestedDate, input.requestedTime, lang);
  const passengers = formatPassengers(input.passengers, input.children, input.childrenAges, lang);
  return lang === "it"
    ? [
        `Tratta: ${route}`,
        `Data: ${when}`,
        `Passeggeri: ${passengers}`,
        ...(input.luggage ? [`Bagagli: ${input.luggage}`] : []),
        ...(input.flightNumber ? [`Volo: ${input.flightNumber}`] : []),
        `Veicolo: ${VEHICLE.it}`,
      ]
    : [
        `Route: ${route}`,
        `Date: ${when}`,
        `Passengers: ${passengers}`,
        ...(input.luggage ? [`Luggage: ${input.luggage}`] : []),
        ...(input.flightNumber ? [`Flight: ${input.flightNumber}`] : []),
        `Vehicle: ${VEHICLE.en}`,
      ];
}

export interface TransferQuoteOfferInput extends TripDetails {
  to: string;
  amountCents: number;
  // null: italian customer, no deposit lines at all.
  depositCents: number | null;
  currency: string;
}

export function buildTransferQuoteOfferContent(input: TransferQuoteOfferInput): CommunicationContent {
  const lang = input.language;
  const money = (cents: number) => formatAmountForCustomer(cents, input.currency, lang);
  const priceLines =
    input.depositCents === null
      ? [NO_DEPOSIT_LINES[lang].price(money(input.amountCents))]
      : [
          DEPOSIT_LINES[lang].total(money(input.amountCents)),
          DEPOSIT_LINES[lang].deposit(money(input.depositCents)),
          DEPOSIT_LINES[lang].balance(money(input.amountCents - input.depositCents)),
          "",
          DEPOSIT_LINES[lang].paymentLink,
        ];

  const lines =
    lang === "it"
      ? [
          "Buongiorno,",
          "grazie per aver scelto Bonolini Transfer. Ecco il Suo preventivo:",
          "",
          ...tripLines(input),
          ...priceLines,
          "",
          "Per confermare il servizio o per qualsiasi domanda, risponda pure a questo messaggio.",
          SIGNATURE,
        ]
      : [
          "Hello,",
          "thank you for choosing Bonolini Transfer. Here is your quote:",
          "",
          ...tripLines(input),
          ...priceLines,
          "",
          "To confirm the service or for any question, simply reply to this message.",
          SIGNATURE,
        ];

  const templateName =
    input.depositCents === null ? `transfer_quote_offer_no_deposit_${lang}_v1` : `transfer_quote_offer_${lang}_v4`;
  return { to: input.to, templateName, body: lines.join("\n") };
}

export interface BookingConfirmationInput extends TripDetails {
  to: string;
  totalCents: number;
  // null: italian customer (no deposit), confirmed by "Confermato dal cliente".
  depositCents: number | null;
  currency: string;
}

export function buildBookingConfirmationContent(input: BookingConfirmationInput): CommunicationContent {
  const lang = input.language;
  if (input.depositCents === null) return buildNoDepositConfirmation(input, lang);
  const balance = formatAmountForCustomer(input.totalCents - input.depositCents, input.currency, lang);
  const lines =
    lang === "it"
      ? [
          "Buongiorno,",
          "abbiamo ricevuto l'acconto: la Sua prenotazione con Bonolini Transfer è confermata.",
          "",
          ...tripLines(input),
          DEPOSIT_LINES.it.balance(balance),
          "",
          DEPOSIT_LINES.it.driverDetails,
          "Per qualsiasi domanda, risponda pure a questo messaggio.",
          SIGNATURE,
        ]
      : [
          "Hello,",
          "we have received your deposit: your booking with Bonolini Transfer is confirmed.",
          "",
          ...tripLines(input),
          DEPOSIT_LINES.en.balance(balance),
          "",
          DEPOSIT_LINES.en.driverDetails,
          "For any question, simply reply to this message.",
          SIGNATURE,
        ];

  return { to: input.to, templateName: `booking_confirmation_${lang}_v2`, body: lines.join("\n") };
}

function buildNoDepositConfirmation(input: BookingConfirmationInput, lang: CustomerLanguage): CommunicationContent {
  const price = NO_DEPOSIT_LINES[lang].price(formatAmountForCustomer(input.totalCents, input.currency, lang));
  const lines = [
    lang === "it" ? "Buongiorno," : "Hello,",
    NO_DEPOSIT_LINES[lang].confirmed,
    "",
    ...tripLines(input),
    price,
    "",
    DEPOSIT_LINES[lang].driverDetails,
    NO_DEPOSIT_LINES[lang].payment,
    lang === "it" ? "Per qualsiasi domanda, risponda pure a questo messaggio." : "For any question, simply reply to this message.",
    SIGNATURE,
  ];
  return { to: input.to, templateName: `booking_confirmation_no_deposit_${lang}_v1`, body: lines.join("\n") };
}
