import { describe, expect, it } from "vitest";
import type { Client, TransferRequest } from "@bos/db";
import { buildQuoteReadyText, decodeButtonId, encodeButtonId, isTypedCommand, parseFounderPrice } from "./content";

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

// Founder decision 2026-09-26: the stored availability result never
// compared the request with other bookings or the calendar, so it must
// never read "compatibile" — until the real overlap check exists.
describe("PREVENTIVO PRONTO — Disponibilità", () => {
  const client = { fullName: "Mario Rossi", phone: "393331234567" } as Client;
  const trWith = (availabilityBreakdown: unknown) =>
    ({
      id: ID,
      pickup: "Malpensa",
      destination: "Sondrio",
      requestedDate: "2026-10-03",
      requestedTime: "14:30",
      passengers: 2,
      children: 0,
      childrenAges: null,
      luggage: null,
      flightNumber: null,
      trainNumber: null,
      hotel: null,
      pricingStatus: "fixed",
      calculatedAmountCents: 25000,
      currency: "EUR",
      availabilityBreakdown,
    }) as unknown as TransferRequest;

  it.each([
    ["feasible", { status: "verified", feasibility: { feasible: true } }],
    ["not feasible", { status: "verified", feasibility: { feasible: false } }],
    ["route not calculated", { status: "not_verified" }],
    ["missing", null],
  ])("always NOT verified (%s), never 'compatibile'", (_label, breakdown) => {
    const { details } = buildQuoteReadyText({
      tr: trWith(breakdown),
      client,
      proposedAmountCents: null,
      customerMessageBody: "…",
    });
    expect(details).toContain(
      "Disponibilità: NON verificata (il BOS non controlla ancora le sovrapposizioni con gli altri servizi e con il calendario)",
    );
    expect(details).not.toMatch(/compatibile/i);
  });
});
