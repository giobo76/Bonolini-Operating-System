import { describe, expect, it } from "vitest";
import { decodeButtonId, encodeButtonId, isTypedCommand, parseFounderPrice } from "./content";

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
