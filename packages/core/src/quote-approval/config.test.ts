import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../whatsapp", () => ({
  normalizePhone: (phone: string) => phone.replace(/[^0-9]/g, ""),
}));

const { isQuoteApprovalEnabled, isCustomerPhoneAllowed } = await import("./config");

beforeEach(() => {
  delete process.env.QUOTE_APPROVAL_ENABLED;
  delete process.env.QUOTE_APPROVAL_TEST_PHONES;
});

describe("QUOTE_APPROVAL_ENABLED", () => {
  it("is on only for the exact string 'true'", () => {
    expect(isQuoteApprovalEnabled()).toBe(false);
    for (const value of ["", "false", "1", "yes", "TRUE", " true"]) {
      process.env.QUOTE_APPROVAL_ENABLED = value;
      expect(isQuoteApprovalEnabled()).toBe(false);
    }
    process.env.QUOTE_APPROVAL_ENABLED = "true";
    expect(isQuoteApprovalEnabled()).toBe(true);
  });
});

describe("QUOTE_APPROVAL_TEST_PHONES", () => {
  it("allows every customer when unset or empty", () => {
    expect(isCustomerPhoneAllowed("393331234567")).toBe(true);
    process.env.QUOTE_APPROVAL_TEST_PHONES = "   ";
    expect(isCustomerPhoneAllowed("393331234567")).toBe(true);
  });

  it("allows only the listed numbers, whatever the separator and the sender's format", () => {
    process.env.QUOTE_APPROVAL_TEST_PHONES = "+393331234567, +447700900123;+15555550100";
    expect(isCustomerPhoneAllowed("393331234567")).toBe(true);
    expect(isCustomerPhoneAllowed("+447700900123")).toBe(true);
    expect(isCustomerPhoneAllowed("15555550100")).toBe(true);
    expect(isCustomerPhoneAllowed("393339999999")).toBe(false);
  });

  it("ignores entries that are not E.164", () => {
    process.env.QUOTE_APPROVAL_TEST_PHONES = "3331234567,+393331234567";
    expect(isCustomerPhoneAllowed("3331234567")).toBe(false);
    expect(isCustomerPhoneAllowed("393331234567")).toBe(true);
  });

  it("fails closed: set but with no valid number means nobody", () => {
    process.env.QUOTE_APPROVAL_TEST_PHONES = "3331234567, abc";
    expect(isCustomerPhoneAllowed("393331234567")).toBe(false);
    expect(isCustomerPhoneAllowed("3331234567")).toBe(false);
  });
});
