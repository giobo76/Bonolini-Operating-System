// Default deposit (founder decision, 2026-09-24): 50% of the total, rounded
// to the nearest 10 €, halves rounded up (390 € -> 200 €, 285 € -> 140 €).
// Integer cents throughout — no floating point on money.
const TEN_EUROS_CENTS = 1000;

export function computeDefaultDepositCents(totalCents: number): number {
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw new Error(`computeDefaultDepositCents: invalid total ${totalCents}`);
  }
  const half = totalCents / 2;
  const rounded = Math.floor((half + TEN_EUROS_CENTS / 2) / TEN_EUROS_CENTS) * TEN_EUROS_CENTS;
  // Below 10 € of deposit the rounding gives 0: ask for the whole amount
  // rather than confirm a booking with no deposit at all.
  if (rounded <= 0) return totalCents;
  return Math.min(rounded, totalCents);
}

export function isValidDeposit(depositCents: number, totalCents: number): boolean {
  return Number.isInteger(depositCents) && depositCents > 0 && depositCents <= totalCents;
}
