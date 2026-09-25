import { describe, expect, it } from "vitest";
import { isMalpensa, isSondrioCity } from "./locations";

describe("isSondrioCity", () => {
  it.each(["Sondrio", "sondrio", " SONDRIO ", "Sondrio centro", "Sondrio città", "Sondrio (SO)", "Stazione di Sondrio", "Sondrio, Italia"])(
    "recognizes %j",
    (place) => {
      expect(isSondrioCity(place)).toBe(true);
    },
  );

  it.each(["Morbegno", "Albosaggia", "Tirano", "Provincia di Sondrio", "Via Roma 1, Sondrio", "Montagna in Valtellina", "", null])(
    "does not treat %j as Sondrio city",
    (place) => {
      expect(isSondrioCity(place)).toBe(false);
    },
  );
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
