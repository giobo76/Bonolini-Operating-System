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
