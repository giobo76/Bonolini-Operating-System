import { describe, expect, it } from "vitest";
import { computeDefaultDepositCents, isValidDeposit } from "./deposit";

describe("computeDefaultDepositCents", () => {
  it.each([
    [39000, 20000], // founder's example: 390 € -> 200 €
    [30000, 15000],
    [28500, 14000], // 142.50 -> 140
    [29000, 15000], // 145 -> 150, half rounds up
    [29990, 15000], // 149.95 -> 150
    [11000, 6000], // 55 -> 60
    [2000, 1000],
    [1500, 1000], // 7.50 -> 10
  ])("%i cents -> %i cents", (total, deposit) => {
    expect(computeDefaultDepositCents(total)).toBe(deposit);
  });

  it("never returns zero or more than the total", () => {
    expect(computeDefaultDepositCents(800)).toBe(800); // 4 € -> 0 after rounding -> whole amount
    expect(computeDefaultDepositCents(1000)).toBe(1000); // 5 € -> 10 €, capped at the total
  });

  it("rejects an invalid total", () => {
    expect(() => computeDefaultDepositCents(0)).toThrow();
    expect(() => computeDefaultDepositCents(-100)).toThrow();
    expect(() => computeDefaultDepositCents(10.5)).toThrow();
  });
});

describe("isValidDeposit", () => {
  it("accepts 0 < deposit <= total only", () => {
    expect(isValidDeposit(10000, 28000)).toBe(true);
    expect(isValidDeposit(28000, 28000)).toBe(true);
    expect(isValidDeposit(0, 28000)).toBe(false);
    expect(isValidDeposit(30000, 28000)).toBe(false);
  });
});
