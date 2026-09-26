import { describe, expect, it } from "vitest";
import {
  buildBookingEventDescription,
  buildBookingEventTitle,
  cancelledTitle,
  computeBusyWindow,
  findRouteMinimum,
  type BookingEventContentInput,
} from "./booking-event-content";

// Founder decisions 2026-09-25: event = the whole busy time (Sondrio ->
// pickup -> destination -> Sondrio), Malpensa minimum 5 hours as a Business
// Rule, 2 hours + "Durata da verificare" without Google Maps.

const MALPENSA_RULE = {
  minimums: [{ label: "Malpensa", placeKeywords: ["malpensa", "mxp"], minimumMinutes: 300 }],
};

const PICKUP_AT = new Date("2026-10-03T12:30:00.000Z"); // 14:30 in Rome

describe("findRouteMinimum", () => {
  it("Malpensa in either direction, and MXP", () => {
    expect(findRouteMinimum(MALPENSA_RULE, "Sondrio", "Malpensa")).toEqual({ label: "Malpensa", minutes: 300 });
    expect(findRouteMinimum(MALPENSA_RULE, "Aeroporto di Milano Malpensa T1", "Via Roma 1, Sondrio")).toEqual({
      label: "Malpensa",
      minutes: 300,
    });
    expect(findRouteMinimum(MALPENSA_RULE, "MXP", "Livigno")?.minutes).toBe(300);
  });

  it("no minimum for other routes, or without the rule", () => {
    expect(findRouteMinimum(MALPENSA_RULE, "Linate", "Sondrio")).toBeNull();
    expect(findRouteMinimum(null, "Malpensa", "Sondrio")).toBeNull();
  });

  it("the largest matching minimum wins", () => {
    const rule = {
      minimums: [
        { label: "Malpensa", placeKeywords: ["malpensa"], minimumMinutes: 300 },
        { label: "Livigno", placeKeywords: ["livigno"], minimumMinutes: 360 },
      ],
    };
    expect(findRouteMinimum(rule, "Malpensa", "Livigno")).toEqual({ label: "Livigno", minutes: 360 });
  });
});

describe("computeBusyWindow", () => {
  it("starts when the founder leaves Sondrio and lasts the whole loop", () => {
    const window = computeBusyWindow({
      pickupAt: PICKUP_AT,
      loopMinutes: 270,
      minutesBeforePickup: 130,
      minimum: null,
      minimumRuleInvalid: false,
    });
    expect(window.startAt.toISOString()).toBe("2026-10-03T10:20:00.000Z");
    expect(window.endAt.toISOString()).toBe("2026-10-03T14:50:00.000Z");
    expect(window.durationToVerify).toBe(false);
    expect(window.minimumApplied).toBeNull();
  });

  it("Malpensa: a shorter loop is extended to the 5-hour minimum", () => {
    const window = computeBusyWindow({
      pickupAt: PICKUP_AT,
      loopMinutes: 260,
      minutesBeforePickup: 0,
      minimum: { label: "Malpensa", minutes: 300 },
      minimumRuleInvalid: false,
    });
    expect(window.startAt.toISOString()).toBe("2026-10-03T12:30:00.000Z");
    expect(window.endAt.toISOString()).toBe("2026-10-03T17:30:00.000Z");
    expect(window.minimumApplied).toEqual({ label: "Malpensa", minutes: 300 });
  });

  it("a loop longer than the minimum keeps its own duration", () => {
    const window = computeBusyWindow({
      pickupAt: PICKUP_AT,
      loopMinutes: 330,
      minutesBeforePickup: 0,
      minimum: { label: "Malpensa", minutes: 300 },
      minimumRuleInvalid: false,
    });
    expect(window.endAt.toISOString()).toBe("2026-10-03T18:00:00.000Z");
    expect(window.minimumApplied).toBeNull();
  });

  it("without Google Maps: from the pickup time, 2 hours, to be checked", () => {
    const window = computeBusyWindow({
      pickupAt: PICKUP_AT,
      loopMinutes: null,
      minutesBeforePickup: null,
      minimum: null,
      minimumRuleInvalid: false,
    });
    expect(window.startAt.toISOString()).toBe("2026-10-03T12:30:00.000Z");
    expect(window.endAt.toISOString()).toBe("2026-10-03T14:30:00.000Z");
    expect(window.durationToVerify).toBe(true);
  });

  it("without Google Maps on a Malpensa route: never less than the minimum, still to be checked", () => {
    const window = computeBusyWindow({
      pickupAt: PICKUP_AT,
      loopMinutes: null,
      minutesBeforePickup: null,
      minimum: { label: "Malpensa", minutes: 300 },
      minimumRuleInvalid: false,
    });
    expect(window.endAt.toISOString()).toBe("2026-10-03T17:30:00.000Z");
    expect(window.durationToVerify).toBe(true);
  });

  it("rounds outward to 5 minutes, never shorter than the real busy time", () => {
    const window = computeBusyWindow({
      pickupAt: PICKUP_AT,
      loopMinutes: 101,
      minutesBeforePickup: 33,
      minimum: null,
      minimumRuleInvalid: false,
    });
    expect(window.startAt.toISOString()).toBe("2026-10-03T11:55:00.000Z");
    expect(window.endAt.toISOString()).toBe("2026-10-03T13:40:00.000Z");
  });

  it("an unreadable minimum rule makes the duration to be checked", () => {
    const window = computeBusyWindow({
      pickupAt: PICKUP_AT,
      loopMinutes: 270,
      minutesBeforePickup: 130,
      minimum: null,
      minimumRuleInvalid: true,
    });
    expect(window.durationToVerify).toBe(true);
  });
});

describe("buildBookingEventTitle", () => {
  it("the founder's format, with the price (the calendar is seen by the founder only)", () => {
    expect(
      buildBookingEventTitle({ clientName: "Mario Rossi", pickup: "Malpensa", destination: "Sondrio", totalCents: 39000, currency: "EUR" }),
    ).toBe("TRANSFER | Mario Rossi | Malpensa → Sondrio | €390");
  });

  it("decimals only when there are some", () => {
    expect(
      buildBookingEventTitle({ clientName: "Mario Rossi", pickup: "Malpensa", destination: "Sondrio", totalCents: 39050, currency: "EUR" }),
    ).toBe("TRANSFER | Mario Rossi | Malpensa → Sondrio | €390,50");
  });
});

function contentInput(overrides: Partial<BookingEventContentInput> = {}): BookingEventContentInput {
  return {
    transferRequestRef: "#a1b2c3",
    clientName: "Mario Rossi",
    clientPhone: "393331234567",
    pickup: "Malpensa",
    destination: "Sondrio",
    requestedDate: "2026-10-03",
    requestedTime: "14:30",
    passengers: 4,
    children: 2,
    childrenAges: "4 e 7",
    luggage: "4 valigie grandi",
    flightNumber: "AZ123",
    trainNumber: null,
    hotel: null,
    totalCents: 39000,
    depositCents: 20000,
    currency: "EUR",
    loopLabel: "Sondrio → Malpensa → Sondrio",
    loopMinutes: 270,
    window: {
      startAt: new Date("2026-10-03T10:20:00.000Z"),
      endAt: new Date("2026-10-03T15:20:00.000Z"),
      durationToVerify: false,
      minimumApplied: { label: "Malpensa", minutes: 300 },
    },
    mapsUnavailable: false,
    ...overrides,
  };
}

describe("buildBookingEventDescription", () => {
  it("every detail the founder asked for", () => {
    expect(buildBookingEventDescription(contentInput())).toBe(
      [
        "Cliente: Mario Rossi",
        "Telefono: +393331234567",
        "Tratta: Malpensa → Sondrio",
        "Ritiro: 03/10/2026 ore 14:30",
        "Passeggeri: 4",
        "Bambini: 2 (età: 4 e 7)",
        "Bagagli: 4 valigie grandi",
        "Volo: AZ123",
        "Prezzo totale: 390,00 €",
        "Acconto ricevuto: 200,00 €",
        "Saldo da incassare: 190,00 €",
        "",
        "Tempo occupato: Sondrio → Malpensa → Sondrio, circa 4 h 30 min (Google Maps)",
        "Durata minima applicata: 5 h (Malpensa)",
        "",
        "Creato dal BOS (rif. #a1b2c3). Modificare o cancellare questo evento non cambia la prenotazione nel BOS.",
      ].join("\n"),
    );
  });

  it("unknown details are written as such, never invented", () => {
    const description = buildBookingEventDescription(
      contentInput({ children: null, childrenAges: null, luggage: null, flightNumber: null, passengers: null }),
    );
    expect(description).toContain("Passeggeri: non indicato");
    expect(description).toContain("Bambini: non indicato");
    expect(description).toContain("Bagagli: non indicato");
    expect(description).toContain("Volo: non indicato");
  });

  it("without Google Maps: 'Durata da verificare'", () => {
    const description = buildBookingEventDescription(
      contentInput({
        loopLabel: null,
        loopMinutes: null,
        mapsUnavailable: true,
        window: {
          startAt: new Date("2026-10-03T12:30:00.000Z"),
          endAt: new Date("2026-10-03T14:30:00.000Z"),
          durationToVerify: true,
          minimumApplied: null,
        },
      }),
    );
    expect(description).toContain("Durata da verificare: Google Maps non ha dato la durata del giro.");
    expect(description).not.toContain("Tempo occupato:");
  });

  it("italian customer (no deposit): the whole amount to collect", () => {
    const description = buildBookingEventDescription(contentInput({ depositCents: null }));
    expect(description).toContain("Prezzo totale: 390,00 €\nAcconto: nessuno (cliente italiano)\nDa incassare: 390,00 €");
    expect(description).not.toContain("Acconto ricevuto");
    expect(description).not.toContain("Saldo");
  });

  it("train and hotel only when known", () => {
    const description = buildBookingEventDescription(contentInput({ trainNumber: "RV 2811", hotel: "Hotel Europa" }));
    expect(description).toContain("Treno: RV 2811");
    expect(description).toContain("Hotel: Hotel Europa");
    expect(buildBookingEventDescription(contentInput())).not.toMatch(/Treno:|Hotel:/);
  });
});

describe("cancelledTitle", () => {
  it("adds the prefix once", () => {
    expect(cancelledTitle("TRANSFER | Mario Rossi | Malpensa → Sondrio | €390")).toBe(
      "ANNULLATO – TRANSFER | Mario Rossi | Malpensa → Sondrio | €390",
    );
    expect(cancelledTitle("ANNULLATO – TRANSFER | Mario Rossi")).toBe("ANNULLATO – TRANSFER | Mario Rossi");
  });
});
