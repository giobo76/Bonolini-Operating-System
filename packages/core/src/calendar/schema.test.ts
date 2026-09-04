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
