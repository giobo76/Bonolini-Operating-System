import { describe, expect, it } from "vitest";
import { generateContactToken, extractContactToken } from "./contact-token";

describe("generateContactToken", () => {
  it("always produces the REF-XXXXXXXX shape", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateContactToken()).toMatch(/^REF-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it("never produces the visually-ambiguous characters 0/O/1/I/L", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateContactToken()).not.toMatch(/[0O1IL]/);
    }
  });

  it("is not deterministic — repeated calls differ", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateContactToken()));
    expect(tokens.size).toBe(20);
  });
});

describe("extractContactToken", () => {
  it("finds a token embedded in real WhatsApp message text", () => {
    expect(extractContactToken("Hi! I'd like a quote. Ref: REF-ABCD2345")).toBe("REF-ABCD2345");
  });

  it("finds a token at the start of the text", () => {
    expect(extractContactToken("REF-XYZW7788 hello")).toBe("REF-XYZW7788");
  });

  it("is case-insensitive but normalizes the result to uppercase", () => {
    expect(extractContactToken("ref-abcd2345")).toBe("REF-ABCD2345");
  });

  it("returns null when no token is present — never guesses or invents one", () => {
    expect(extractContactToken("Hi, I'd like a transfer from Milan to Tirano tomorrow")).toBeNull();
  });

  it("returns null when too few valid characters follow REF- to form a real 8-char token", () => {
    expect(extractContactToken("REF-ABCD")).toBeNull();
  });

  it("returns the first match when multiple tokens appear (deterministic, not arbitrary)", () => {
    expect(extractContactToken("REF-AAAA2222 and also REF-BBBB3333")).toBe("REF-AAAA2222");
  });

  it("round-trips: every generated token is extractable from a realistic surrounding message", () => {
    const token = generateContactToken();
    const message = `Ciao! Vorrei un preventivo per un transfer.\n\n${token}`;
    expect(extractContactToken(message)).toBe(token);
  });
});
