import { describe, expect, it } from "vitest";
import {
  buildMissingInfoRequestContent,
  buildTransferQuoteOfferContent,
  buildBookingConfirmationContent,
  capitalizePlace,
  formatLongDateTime,
  formatPassengers,
  toCustomerLanguage,
  type TransferQuoteOfferInput,
} from "./content";

// The expected texts below are the founder's own wording (2026-09-24),
// compared verbatim.

const ALL_MISSING = ["pickup", "destination", "passengers", "date", "time", "flight_number"];

describe("missing information question", () => {
  it("Italian, everything missing: the founder's text verbatim", () => {
    const { body } = buildMissingInfoRequestContent({
      to: "+393331234567",
      language: "it",
      missing: ALL_MISSING,
      askChildren: true,
      askChildrenAges: false,
      askLuggage: true,
    });
    expect(body).toBe(
      [
        "Buongiorno e grazie per aver contattato Bonolini Transfer.",
        "Per preparare il Suo preventivo ci servono ancora:",
        "- luogo di partenza",
        "- destinazione",
        "- data del viaggio",
        "- orario di partenza",
        "- numero di passeggeri",
        "- numero del volo",
        "",
        "Se possibile, ci indichi anche:",
        "- quanti bambini viaggiano e la loro età (per i seggiolini)",
        "- quanti bagagli sono previsti (valigie grandi e bagagli a mano)",
        "",
        "Bonolini Transfer – Private Transfers",
      ].join("\n"),
    );
  });

  it("English, everything missing: the founder's text verbatim", () => {
    const { body } = buildMissingInfoRequestContent({
      to: "+447700900123",
      language: "en",
      missing: ALL_MISSING,
      askChildren: true,
      askChildrenAges: false,
      askLuggage: true,
    });
    expect(body).toBe(
      [
        "Hello and thank you for contacting Bonolini Transfer.",
        "To prepare your quote, we still need:",
        "- pickup location",
        "- destination",
        "- travel date",
        "- pickup time",
        "- number of passengers",
        "- flight number",
        "",
        "If possible, please also let us know:",
        "- how many children are travelling and their ages (for child seats)",
        "- how much luggage you have (large suitcases and carry-ons)",
        "",
        "Bonolini Transfer – Private Transfers",
      ].join("\n"),
    );
  });

  it("lists only what is missing, in the founder's order, and skips the optional block when nothing optional is missing", () => {
    const { body } = buildMissingInfoRequestContent({
      to: "+39333",
      language: "it",
      missing: ["time", "date"],
      askChildren: false,
      askChildrenAges: false,
      askLuggage: false,
    });
    expect(body).toBe(
      [
        "Buongiorno e grazie per aver contattato Bonolini Transfer.",
        "Per preparare il Suo preventivo ci servono ancora:",
        "- data del viaggio",
        "- orario di partenza",
        "",
        "Bonolini Transfer – Private Transfers",
      ].join("\n"),
    );
  });

  it("asks only the ages when the number of children is already known", () => {
    const it_ = buildMissingInfoRequestContent({
      to: "+39333",
      language: "it",
      missing: ["date"],
      askChildren: false,
      askChildrenAges: true,
      askLuggage: false,
    }).body;
    expect(it_).toContain("- l'età dei bambini (per i seggiolini)");
    expect(it_).not.toContain("quanti bambini");
    expect(it_).not.toContain("bagagli");

    const en = buildMissingInfoRequestContent({
      to: "+44",
      language: "en",
      missing: ["date"],
      askChildren: false,
      askChildrenAges: true,
      askLuggage: false,
    }).body;
    expect(en).toContain("- the ages of the children (for child seats)");
  });

  it("never contains a price or the word taxi", () => {
    for (const language of ["it", "en"] as const) {
      const { body } = buildMissingInfoRequestContent({
        to: "+39333",
        language,
        missing: ALL_MISSING,
        askChildren: true,
        askChildrenAges: false,
        askLuggage: true,
      });
      expect(body).not.toMatch(/€|\d+[.,]\d{2}|taxi/i);
    }
  });

  it("refuses to build a question with nothing blocking to ask", () => {
    expect(() =>
      buildMissingInfoRequestContent({
        to: "+39333",
        language: "it",
        missing: [],
        askChildren: true,
        askChildrenAges: false,
        askLuggage: true,
      }),
    ).toThrow();
  });
});

const FULL_QUOTE: Omit<TransferQuoteOfferInput, "language"> = {
  to: "+393331234567",
  pickup: "malpensa",
  destination: "sondrio",
  requestedDate: "2026-10-03",
  requestedTime: "14:30",
  passengers: 4,
  children: 2,
  childrenAges: "4 e 7 anni",
  luggage: "4 valigie grandi",
  flightNumber: "AZ123",
  amountCents: 30000,
  depositCents: 15000,
  currency: "EUR",
};

describe("quote", () => {
  it("Italian, every detail known: founder text + DRAFT price lines", () => {
    const { body } = buildTransferQuoteOfferContent({ ...FULL_QUOTE, language: "it" });
    expect(body).toBe(
      [
        "Buongiorno,",
        "grazie per aver scelto Bonolini Transfer. Ecco il Suo preventivo:",
        "",
        "Tratta: Malpensa → Sondrio",
        "Data: 3 ottobre 2026, ore 14:30",
        "Passeggeri: 2 adulti + 2 bambini (4 e 7 anni)",
        "Bagagli: 4 valigie grandi",
        "Volo: AZ123",
        "Veicolo: Mercedes V-Class con autista privato",
        "Prezzo totale: 300,00 € per l'intero veicolo",
        "Acconto per confermare: 150,00 €",
        "Saldo all'autista il giorno del servizio: 150,00 €",
        "",
        "Per confermare il servizio o per qualsiasi domanda, risponda pure a questo messaggio.",
        "Bonolini Transfer – Private Transfers",
      ].join("\n"),
    );
  });

  it("English, every detail known: founder text + DRAFT price lines", () => {
    const { body } = buildTransferQuoteOfferContent({
      ...FULL_QUOTE,
      childrenAges: "4 and 7",
      luggage: "4 large suitcases",
      language: "en",
    });
    expect(body).toBe(
      [
        "Hello,",
        "thank you for choosing Bonolini Transfer. Here is your quote:",
        "",
        "Route: Malpensa → Sondrio",
        "Date: 3 October 2026 at 14:30",
        "Passengers: 2 adults + 2 children (ages 4 and 7)",
        "Luggage: 4 large suitcases",
        "Flight: AZ123",
        "Vehicle: Mercedes V-Class with private driver",
        "Total price: €300.00 for the entire vehicle",
        "Deposit to confirm: €150.00",
        "Balance to the driver on the day of service: €150.00",
        "",
        "To confirm the service or for any question, simply reply to this message.",
        "Bonolini Transfer – Private Transfers",
      ].join("\n"),
    );
  });

  it("balance is total minus deposit", () => {
    const { body } = buildTransferQuoteOfferContent({ ...FULL_QUOTE, amountCents: 28000, depositCents: 10000, language: "it" });
    expect(body).toContain("Prezzo totale: 280,00 € per l'intero veicolo");
    expect(body).toContain("Acconto per confermare: 100,00 €");
    expect(body).toContain("Saldo all'autista il giorno del servizio: 180,00 €");
  });

  it("never contains a payment link", () => {
    for (const language of ["it", "en"] as const) {
      expect(buildTransferQuoteOfferContent({ ...FULL_QUOTE, language }).body).not.toMatch(/https?:|sumup/i);
    }
  });

  it("omits Bagagli and Volo when unknown, but always shows Veicolo", () => {
    const { body } = buildTransferQuoteOfferContent({
      ...FULL_QUOTE,
      passengers: 2,
      children: null,
      childrenAges: null,
      luggage: null,
      flightNumber: null,
      language: "it",
    });
    expect(body).toContain("Passeggeri: 2\n");
    expect(body).not.toContain("Bagagli:");
    expect(body).not.toContain("Volo:");
    expect(body).not.toContain("bambin");
    expect(body).toContain("Veicolo: Mercedes V-Class con autista privato");
  });

  it("never says taxi", () => {
    for (const language of ["it", "en"] as const) {
      expect(buildTransferQuoteOfferContent({ ...FULL_QUOTE, language }).body).not.toMatch(/taxi/i);
    }
  });
});

// DRAFT texts (not yet the founder's wording) — structure only.
describe("booking confirmation", () => {
  const trip = {
    to: FULL_QUOTE.to,
    pickup: FULL_QUOTE.pickup,
    destination: FULL_QUOTE.destination,
    requestedDate: FULL_QUOTE.requestedDate,
    requestedTime: FULL_QUOTE.requestedTime,
    passengers: FULL_QUOTE.passengers,
    children: FULL_QUOTE.children,
    childrenAges: FULL_QUOTE.childrenAges,
    luggage: FULL_QUOTE.luggage,
    flightNumber: FULL_QUOTE.flightNumber,
    currency: FULL_QUOTE.currency,
  };

  it("Italian: date and time of the booking, balance, signature, never taxi", () => {
    const { body, to } = buildBookingConfirmationContent({ ...trip, language: "it", balanceCents: 15000 });
    expect(to).toBe("+393331234567");
    expect(body).toContain("confermata");
    expect(body).toContain("Data: 3 ottobre 2026, ore 14:30");
    expect(body).toContain("Tratta: Malpensa → Sondrio");
    expect(body).toContain("Saldo all'autista il giorno del servizio: 150,00 €");
    expect(body.endsWith("Bonolini Transfer – Private Transfers")).toBe(true);
    expect(body).not.toMatch(/taxi|https?:/i);
  });

  it("English", () => {
    const { body } = buildBookingConfirmationContent({ ...trip, language: "en", balanceCents: 15000 });
    expect(body).toContain("confirmed");
    expect(body).toContain("Date: 3 October 2026 at 14:30");
    expect(body).toContain("Balance to the driver on the day of service: €150.00");
    expect(body).not.toMatch(/taxi|https?:/i);
  });
});

describe("formatting helpers", () => {
  it("maps detected languages to Italian or English", () => {
    expect(toCustomerLanguage(null)).toBe("it");
    expect(toCustomerLanguage("Italian")).toBe("it");
    expect(toCustomerLanguage("italiano")).toBe("it");
    expect(toCustomerLanguage("en")).toBe("en");
    expect(toCustomerLanguage("German")).toBe("en");
  });

  it("writes the date in full", () => {
    expect(formatLongDateTime("2026-01-09", "08:05", "it")).toBe("9 gennaio 2026, ore 08:05");
    expect(formatLongDateTime("2026-12-31", "23:00", "en")).toBe("31 December 2026 at 23:00");
    expect(formatLongDateTime("domani", "10:00", "it")).toBe("domani, ore 10:00");
  });

  it("capitalizes only the first letter, for display", () => {
    expect(capitalizePlace("malpensa")).toBe("Malpensa");
    expect(capitalizePlace("aeroporto di linate")).toBe("Aeroporto di linate");
    expect(capitalizePlace("St. Moritz")).toBe("St. Moritz");
  });

  it("splits adults and children only when consistent", () => {
    expect(formatPassengers(3, 1, "5", "it")).toBe("2 adulti + 1 bambino (5 anni)");
    expect(formatPassengers(2, 1, "1", "it")).toBe("1 adulto + 1 bambino (1 anno)");
    expect(formatPassengers(3, 1, "5", "en")).toBe("2 adults + 1 child (age 5)");
    expect(formatPassengers(5, 3, "2, 4 e 9", "it")).toBe("2 adulti + 3 bambini (2, 4 e 9 anni)");
    expect(formatPassengers(4, 2, "piccoli", "it")).toBe("2 adulti + 2 bambini (età: piccoli)");
    expect(formatPassengers(4, 2, null, "it")).toBe("2 adulti + 2 bambini");
    expect(formatPassengers(2, 0, null, "it")).toBe("2");
    expect(formatPassengers(2, null, null, "it")).toBe("2");
    expect(formatPassengers(2, 2, "4 e 7", "it")).toBe("2");
  });
});
