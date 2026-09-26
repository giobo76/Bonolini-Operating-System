import { describe, expect, it } from "vitest";
import type { Client, TransferRequest } from "@bos/db";
import type { AvailabilityCheck } from "./availability-check";
import {
  buildQuoteReadyText,
  decodeButtonId,
  decodeDepositButtonId,
  encodeButtonId,
  encodeDepositButtonId,
  isTypedCommand,
  parseFounderPrice,
  parseFounderPriceAndDeposit,
} from "./content";

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

describe("parseFounderPriceAndDeposit", () => {
  it("reads a price alone or a price and a deposit", () => {
    expect(parseFounderPriceAndDeposit("280")).toEqual({ amountCents: 28000, depositCents: null });
    expect(parseFounderPriceAndDeposit("280 100")).toEqual({ amountCents: 28000, depositCents: 10000 });
    expect(parseFounderPriceAndDeposit(" 280€  100,50 ")).toEqual({ amountCents: 28000, depositCents: 10050 });
  });

  it.each(["", "280 100 50", "280 acconto 100", "ciao", "280 x"])("rejects %j", (text) => {
    expect(parseFounderPriceAndDeposit(text)).toBeNull();
  });
});

describe("deposit button id", () => {
  it("round-trips and rejects anything else", () => {
    expect(decodeDepositButtonId(encodeDepositButtonId(ID))).toBe(ID);
    expect(decodeDepositButtonId(`bk:${ID}:other`)).toBeNull();
    expect(decodeDepositButtonId(`qa:${ID}:approve`)).toBeNull();
    expect(decodeDepositButtonId("bk:not-a-uuid:deposit_received")).toBeNull();
    expect(encodeDepositButtonId(ID).length).toBeLessThanOrEqual(256);
  });
});

// Founder decisions 2026-09-26: "Disponibilità" is the overlap check stored
// on the round — never "compatibile" without a real comparison.
describe("PREVENTIVO PRONTO — Disponibilità", () => {
  const client = { fullName: "Mario Rossi", phone: "393331234567" } as Client;
  const tr = {
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
    // The old stored result: ignored, whatever it says.
    availabilityBreakdown: { status: "verified", feasibility: { feasible: true } },
  } as unknown as TransferRequest;

  const candidate = {
    // 12:20-17:30 in Rome
    startAt: "2026-10-03T10:20:00.000Z",
    endAt: "2026-10-03T15:30:00.000Z",
    durationToVerify: false,
    minimumApplied: null,
    loopLabel: "Sondrio → Malpensa → Sondrio",
    loopMinutes: 310,
    mapsUnavailable: false,
    minimumRuleInvalid: false,
  };

  function details(availabilityCheck: AvailabilityCheck | null) {
    return buildQuoteReadyText({
      tr,
      client,
      proposedAmountCents: null,
      depositCents: 12500,
      depositIsCustom: false,
      customerMessageBody: "…",
      availabilityCheck,
    }).details;
  }

  it("no check on the round: NOT verified, never 'compatibile'", () => {
    const text = details(null);
    expect(text).toContain("Disponibilità: NON verificata (controllo non eseguito per questo preventivo)");
    expect(text).not.toMatch(/compatibile/i);
  });

  it("nothing overlaps: free, with what was checked, and the busy time of this service", () => {
    const text = details({
      checkedAt: "2026-09-26T10:00:00.000Z",
      candidate,
      overlaps: [],
      bookingsChecked: 3,
      calendarChecked: true,
      notVerifiedReasons: [],
    });
    expect(text).toContain("Tempo occupato per questo servizio: 12:20–17:30");
    expect(text).toContain("Disponibilità: libera (controllate 3 prenotazioni e il calendario)");
  });

  it("overlaps: one line per booking or calendar event, with its details", () => {
    const text = details({
      checkedAt: "2026-09-26T10:00:00.000Z",
      candidate,
      overlaps: [
        {
          kind: "booking",
          startAt: "2026-10-03T09:00:00.000Z",
          endAt: "2026-10-03T13:00:00.000Z",
          durationToVerify: false,
          clientName: "Anna Bianchi",
          pickup: "Sondrio",
          destination: "Linate",
          pickupAt: "2026-10-03T09:00:00.000Z",
          bookingStatus: "confirmed",
          ref: "#abcdef",
        },
        {
          kind: "calendar_event",
          startAt: "2026-10-03T13:00:00.000Z",
          endAt: "2026-10-03T14:00:00.000Z",
          durationToVerify: false,
          summary: "Dentista",
          allDay: false,
        },
      ],
      bookingsChecked: 2,
      calendarChecked: true,
      notVerifiedReasons: [],
    });
    expect(text).toContain(
      "⚠️ SOVRAPPOSIZIONE CON: Anna Bianchi, Sondrio → Linate, 03/10 ore 11:00 (occupato 11:00–15:00), prenotazione confermata #abcdef",
    );
    expect(text).toContain("⚠️ SOVRAPPOSIZIONE CON: evento Calendar «Dentista», 03/10 15:00–16:00");
    expect(text).not.toContain("Disponibilità: libera");
  });

  it("incomplete check: NOT verified with the reason, and the overlaps found anyway", () => {
    const text = details({
      checkedAt: "2026-09-26T10:00:00.000Z",
      candidate: { ...candidate, durationToVerify: true },
      overlaps: [
        {
          kind: "booking",
          startAt: "2026-10-03T12:00:00.000Z",
          endAt: "2026-10-03T14:00:00.000Z",
          durationToVerify: true,
          clientName: "Anna Bianchi",
          pickup: "Tirano",
          destination: "Bormio",
          pickupAt: "2026-10-03T12:00:00.000Z",
          bookingStatus: "pending_confirmation",
          ref: "#abcdef",
        },
      ],
      bookingsChecked: 1,
      calendarChecked: false,
      notVerifiedReasons: ["Google Calendar non collegato nel pannello"],
    });
    expect(text).toContain("Tempo occupato per questo servizio: 12:20–17:30 (durata da verificare)");
    expect(text).toContain("(occupato 14:00–16:00, durata da verificare), prenotazione in attesa di conferma #abcdef");
    expect(text).toContain("Disponibilità: NON verificata (Google Calendar non collegato nel pannello)");
  });

  it("an all-day event", () => {
    const text = details({
      checkedAt: "2026-09-26T10:00:00.000Z",
      candidate,
      overlaps: [
        {
          kind: "calendar_event",
          startAt: "2026-10-02T22:00:00.000Z",
          endAt: "2026-10-03T22:00:00.000Z",
          durationToVerify: false,
          summary: "Ferie",
          allDay: true,
        },
      ],
      bookingsChecked: 0,
      calendarChecked: true,
      notVerifiedReasons: [],
    });
    expect(text).toContain("⚠️ SOVRAPPOSIZIONE CON: evento Calendar «Ferie», 03/10 tutto il giorno");
  });
});
