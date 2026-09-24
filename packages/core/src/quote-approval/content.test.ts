import { describe, expect, it } from "vitest";
import { decodeButtonId, encodeButtonId, isTypedCommand, parseFounderPrice } from "./content";
import {
  buildMissingInfoRequestContent,
  buildTransferQuoteOfferContent,
  toCustomerLanguage,
} from "../communications/content";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("button ids", () => {
  it("round-trips every action", () => {
    for (const action of ["approve", "modify", "reject"] as const) {
      expect(decodeButtonId(encodeButtonId(ID, action))).toEqual({ approvalRequestId: ID, action });
    }
  });

  it("rejects anything that is not exactly one of our ids", () => {
    expect(decodeButtonId(`qa:${ID}:delete`)).toBeNull();
    expect(decodeButtonId(`qa:not-a-uuid:approve`)).toBeNull();
    expect(decodeButtonId(`xx:${ID}:approve`)).toBeNull();
    expect(decodeButtonId(`qa:${ID}:approve:extra`)).toBeNull();
  });
});

describe("parseFounderPrice", () => {
  it.each([
    ["280", 28000],
    ["280€", 28000],
    ["€ 280", 28000],
    ["280,50", 28050],
    ["280.5", 28050],
    ["280 euro", 28000],
  ])("%s -> %d cents", (text, cents) => {
    expect(parseFounderPrice(text)).toBe(cents);
  });

  it.each(["", "0", "1.280,00", "circa 280", "280 o 300", "ciao"])("rejects %j", (text) => {
    expect(parseFounderPrice(text)).toBeNull();
  });
});

describe("isTypedCommand", () => {
  it("recognizes typed commands in any case", () => {
    expect(isTypedCommand("approva")).toBe(true);
    expect(isTypedCommand("RIFIUTA grazie")).toBe(true);
    expect(isTypedCommand("ciao")).toBe(false);
  });
});

describe("customer texts", () => {
  it("maps detected languages to Italian or English", () => {
    expect(toCustomerLanguage(null)).toBe("it");
    expect(toCustomerLanguage("Italian")).toBe("it");
    expect(toCustomerLanguage("italiano")).toBe("it");
    expect(toCustomerLanguage("en")).toBe("en");
    expect(toCustomerLanguage("German")).toBe("en");
  });

  const quote = {
    to: "+393331234567",
    pickup: "Malpensa",
    destination: "Sondrio",
    requestedDate: "2026-10-03",
    requestedTime: "14:30",
    passengers: 2,
    flightNumber: "AZ123",
    amountCents: 30000,
    currency: "EUR",
  };

  it("builds the Italian quote with every trip detail and never says taxi", () => {
    const { body } = buildTransferQuoteOfferContent({ ...quote, language: "it" });
    expect(body).toContain("Tratta: Malpensa → Sondrio");
    expect(body).toContain("Data: 03/10/2026 alle 14:30");
    expect(body).toContain("Volo: AZ123");
    expect(body).toContain("Prezzo: 300,00 €");
    expect(body).not.toMatch(/taxi/i);
  });

  it("builds the English quote", () => {
    const { body } = buildTransferQuoteOfferContent({ ...quote, language: "en", flightNumber: null });
    expect(body).toContain("Route: Malpensa → Sondrio");
    expect(body).toContain("Price: €300.00");
    expect(body).not.toContain("Flight:");
    expect(body).not.toMatch(/taxi/i);
  });

  it("asks only the ages when the number of children is already known", () => {
    const { body } = buildMissingInfoRequestContent({
      to: "+39333",
      language: "it",
      missing: ["date"],
      askChildren: false,
      askChildrenAges: true,
      askLuggage: false,
      isFollowUp: true,
    });
    expect(body.startsWith("Grazie.")).toBe(true);
    expect(body).toContain("l'età dei bambini");
    expect(body).not.toContain("bagagli");
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
        isFollowUp: false,
      }),
    ).toThrow();
  });
});
