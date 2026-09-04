import { describe, expect, it } from "vitest";
import { parseCalendarEvent, isRecognizableService } from "./schema";

describe("parseCalendarEvent", () => {
  it("extracts pickup/destination/price/name from the suggested pipe-delimited format", () => {
    const parsed = parseCalendarEvent("TRANSFER | Mario Rossi | Milano → Tirano | €390", null);

    expect(parsed.pickup).toBe("Milano");
    expect(parsed.destination).toBe("Tirano");
    expect(parsed.priceCents).toBe(39000);
    expect(parsed.clientName).toBe("Mario Rossi");
  });

  it("extracts pickup/destination from a plain arrow, without the pipe format", () => {
    const parsed = parseCalendarEvent("Sondrio → Malpensa", null);

    expect(parsed.pickup).toBe("Sondrio");
    expect(parsed.destination).toBe("Malpensa");
    // No pipes at all -> name is never guessed from free text.
    expect(parsed.clientName).toBeNull();
  });

  it("accepts the ASCII '->' arrow as well as '→'", () => {
    const parsed = parseCalendarEvent("Como -> Lugano", null);

    expect(parsed.pickup).toBe("Como");
    expect(parsed.destination).toBe("Lugano");
  });

  it("never extracts a route when no arrow is present at all", () => {
    const parsed = parseCalendarEvent("Dentist appointment", null);

    expect(parsed.pickup).toBeNull();
    expect(parsed.destination).toBeNull();
  });

  it("never guesses a price with a decimal separator — genuinely ambiguous, left null", () => {
    const parsed = parseCalendarEvent("TRANSFER | Anna Bianchi | Milano → Tirano | €390,00", null);

    expect(parsed.priceCents).toBeNull();
  });

  it("never guesses a price with a thousands separator — genuinely ambiguous, left null", () => {
    const parsed = parseCalendarEvent("TRANSFER | Anna Bianchi | Milano → Tirano | €1.200", null);

    expect(parsed.priceCents).toBeNull();
  });

  it("extracts a bare integer price from the description when absent from the summary", () => {
    const parsed = parseCalendarEvent("Milano → Tirano", "Price: €390\nPhone: +39 333 1234567");

    expect(parsed.priceCents).toBe(39000);
  });

  it("extracts phone/email/gclid/utm from simple 'Key: value' description lines", () => {
    const description = [
      "Phone: +39 333 1234567",
      "Email: mario.rossi@example.com",
      "GCLID: Cj0KEQjw_test_value",
      "UTM Source: google",
      "UTM Campaign: summer24",
    ].join("\n");

    const parsed = parseCalendarEvent("Milano → Tirano", description);

    expect(parsed.phone).toBe("+39 333 1234567");
    expect(parsed.email).toBe("mario.rossi@example.com");
    expect(parsed.gclid).toBe("Cj0KEQjw_test_value");
    expect(parsed.utmSource).toBe("google");
    expect(parsed.utmCampaign).toBe("summer24");
  });

  it("also accepts 'Tel:'/'Telefono:' as phone line labels", () => {
    expect(parseCalendarEvent("Milano → Tirano", "Tel: 333 1234567").phone).toBe("333 1234567");
    expect(parseCalendarEvent("Milano → Tirano", "Telefono: 333 1234567").phone).toBe("333 1234567");
  });

  it("never invents phone/email/gclid/utm when the description has none of those lines", () => {
    const parsed = parseCalendarEvent("Milano → Tirano", "Just a free-text note, no structured fields.");

    expect(parsed.phone).toBeNull();
    expect(parsed.email).toBeNull();
    expect(parsed.gclid).toBeNull();
    expect(parsed.utmSource).toBeNull();
    expect(parsed.utmCampaign).toBeNull();
  });

  it("handles a null description without throwing", () => {
    const parsed = parseCalendarEvent("Milano → Tirano", null);

    expect(parsed.phone).toBeNull();
    expect(parsed.priceCents).toBeNull();
  });
});

// Regression suite for the 2026-09-04 live diagnosis: real events fetched
// directly from the founder's actual Production Google Calendar (via
// events.list, no mocking) proved every real, pre-existing event title
// uses "(Place - Place)" in parentheses, never the "→"/"->" arrow this
// parser originally required exclusively — and real descriptions embed
// "Tel:"/"Cliente:"/"Passeggero:" mid-sentence, never as a standalone
// "Key: value" line. These exact strings are the real Production data
// (titles/descriptions), not synthesized examples.
describe("parseCalendarEvent — real Production event formats (2026-09-04 diagnosis)", () => {
  it("recognizes the parenthetical '(Pickup - Destination)' format actually in use", () => {
    const parsed = parseCalendarEvent("Servizio Mario (Milano Duomo - Tirano)", null);
    expect(parsed.pickup).toBe("Milano Duomo");
    expect(parsed.destination).toBe("Tirano");
  });

  it("recognizes it inside a bracketed/prefixed real title too", () => {
    const parsed = parseCalendarEvent("[SERVIZIO PER CRISTIAN] Alessandro (MXP T1 - Morbegno)", null);
    expect(parsed.pickup).toBe("MXP T1");
    expect(parsed.destination).toBe("Morbegno");
  });

  it("never mistakes a parenthetical time range for a route", () => {
    const parsed = parseCalendarEvent("Dentist appointment (09:00 - 09:15)", null);
    expect(parsed.pickup).toBeNull();
    expect(parsed.destination).toBeNull();
  });

  it("still ignores a title with no route at all, in either format", () => {
    const parsed = parseCalendarEvent("Florida x centrale io x cristian.", null);
    expect(isRecognizableService(parsed)).toBe(false);
  });

  it("still prefers the arrow format when both the arrow and a parenthetical dash are present", () => {
    // Guards against the parenthetical fallback accidentally taking over
    // the originally-suggested, unambiguous arrow format.
    const parsed = parseCalendarEvent("TRANSFER | Mario Rossi | Milano → Tirano | €390 (nota: solo andata)", null);
    expect(parsed.pickup).toBe("Milano");
    expect(parsed.destination).toBe("Tirano");
  });

  it("extracts a phone embedded mid-sentence, not just on its own line", () => {
    const description =
      "Cliente: Mario (Tel: +1 (909) 282-7598) Pick-up: The Square Milano Duomo (ore 06:30 AM) Drop-off: Stazione di Tirano";
    const parsed = parseCalendarEvent("Servizio Mario (Milano Duomo - Tirano)", description);
    // Normalizes safely downstream via clients.findOrCreateClientByPhone's
    // own digit-stripping — the exact surrounding punctuation captured
    // here doesn't need to be pixel-perfect, only to contain every digit.
    expect(parsed.phone?.replace(/[^0-9]/g, "")).toBe("19092827598");
  });

  it("picks the first phone, deterministically, when a description carries more than one", () => {
    const description =
      "Commitgente: BLACK TAXI DI GAMBETTA CRISTIAN (Tel: 3319056500) Passeggero: ALESSANDRO VOLA (Tel: 339 7888797) Pick-up: MORBEGNO VIA PRETORIO";
    const parsed = parseCalendarEvent("Servizio Cristian per Giovanni - Alessandro Vola (Morbegno - MXP T1)", description);
    expect(parsed.phone?.replace(/[^0-9]/g, "")).toBe("3319056500");
  });

  it("extracts the client name from a 'Passeggero:' label in the description, not the intermediary's 'Commitgente:'", () => {
    const description =
      "Commitgente: BLACK TAXI DI GAMBETTA CRISTIAN (Tel: 3319056500) Passeggero: ALESSANDRO VOLA (Tel: 339 7888797) Pick-up: MORBEGNO VIA PRETORIO";
    const parsed = parseCalendarEvent("Servizio Cristian per Giovanni - Alessandro Vola (Morbegno - MXP T1)", description);
    expect(parsed.clientName).toBe("ALESSANDRO VOLA");
  });

  it("extracts the client name from a 'Cliente:' label too", () => {
    const parsed = parseCalendarEvent(
      "Servizio Mario (Milano Duomo - Tirano)",
      "Cliente: Mario (Tel: +1 (909) 282-7598) Pick-up: The Square Milano Duomo",
    );
    expect(parsed.clientName).toBe("Mario");
  });

  // The exact original bug report: a real event with this exact title and
  // NO description at all. The parser correctly recognizes the route (this
  // was never the actual bug) — the real root cause is downstream, in
  // orchestration (see service.test.ts's matching regression test).
  it("recognizes 'Sondrio → Malpensa' (the exact real event from the bug report) as a valid route, with no phone since there's no description", () => {
    const parsed = parseCalendarEvent("Sondrio → Malpensa", null);
    expect(parsed.pickup).toBe("Sondrio");
    expect(parsed.destination).toBe("Malpensa");
    expect(isRecognizableService(parsed)).toBe(true);
    expect(parsed.phone).toBeNull();
  });
});

describe("isRecognizableService", () => {
  it("is true only when both pickup and destination were extracted", () => {
    expect(isRecognizableService(parseCalendarEvent("Milano → Tirano", null))).toBe(true);
  });

  // TEST 13 — evento fuori dal formato riconoscibile -> ignorato.
  it("is false for an event with no recognizable route — e.g. a personal calendar entry", () => {
    expect(isRecognizableService(parseCalendarEvent("Dentist appointment", "some notes"))).toBe(false);
    expect(isRecognizableService(parseCalendarEvent("Lunch with Marco", null))).toBe(false);
  });
});
