import { describe, expect, it } from "vitest";
import { isMalpensa, isSondrioCity, mentionsPlace } from "./locations";

describe("isSondrioCity", () => {
  it.each(["Sondrio", "sondrio", " SONDRIO ", "Sondrio centro", "Sondrio città", "Sondrio (SO)", "Stazione di Sondrio", "Sondrio, Italia"])(
    "recognizes %j",
    (place) => {
      expect(isSondrioCity(place)).toBe(true);
    },
  );

  it.each([
    "Via Roma 1, Sondrio",
    "Piazza Garibaldi, Sondrio (SO)",
    "Piazza Garibaldi 3, Sondrio SO",
    "Via Roma 1 Sondrio SO",
    "Via Roma 1 Sondrio (SO)",
    "Via Roma 1, 23100 Sondrio",
    "Via Roma, 1, 23100 Sondrio SO, Italia",
    "Via Roma 1, 23100",
    "Via Sondrio 5, Sondrio",
    "Hotel Europa, Sondrio",
    "Stazione FS, Sondrio, Italy",
  ])("recognizes the full address %j", (place) => {
    expect(isSondrioCity(place)).toBe(true);
  });

  it.each([
    "Morbegno",
    "Albosaggia",
    "Tirano",
    "Provincia di Sondrio",
    "Montagna in Valtellina",
    "Via Sondrio 10, Milano",
    "Via Sondrio, Milano",
    "Via Sondrio",
    "Via Sondrio 10, 20124 Milano",
    "Via Sondrio 10, 23100 Milano",
    "Via Roma 1, Morbegno (SO)",
    "Via Roma 1, 23017 Morbegno SO",
    "Albosaggia, Sondrio",
    "Albosaggia (SO)",
    "Montagna in Valtellina, Sondrio (SO)",
    "Sondrio, Milano",
    "",
    null,
  ])("does not treat %j as Sondrio city", (place) => {
    expect(isSondrioCity(place)).toBe(false);
  });
});

describe("isMalpensa", () => {
  it("recognizes Malpensa and MXP, not other airports", () => {
    expect(isMalpensa("Malpensa")).toBe(true);
    expect(isMalpensa("Aeroporto di Milano Malpensa T1")).toBe(true);
    expect(isMalpensa("MXP")).toBe(true);
    expect(isMalpensa("Linate")).toBe(false);
    expect(isMalpensa("Orio al Serio")).toBe(false);
  });
});

describe("mentionsPlace", () => {
  it("matches whole words, accents and case ignored", () => {
    expect(mentionsPlace("Aeroporto di Milano Malpensa T1", "malpensa")).toBe(true);
    expect(mentionsPlace("MXP", "mxp")).toBe(true);
    expect(mentionsPlace("Città Alta, Bergamo", "citta alta")).toBe(true);
    expect(mentionsPlace("Via Comolli 3, Sondrio", "como")).toBe(false);
    expect(mentionsPlace("Linate", "malpensa")).toBe(false);
    expect(mentionsPlace(null, "malpensa")).toBe(false);
    expect(mentionsPlace("Malpensa", "  ")).toBe(false);
  });
});
