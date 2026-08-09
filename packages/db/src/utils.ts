// packages/config/tsconfig.base.json sets noUncheckedIndexedAccess, which
// types array-destructured elements (`const [row] = rows`) as `T | undefined`
// — including from a plain `.insert(...).returning()` where exactly one row
// is a true runtime invariant (no ON CONFLICT clause), not something that
// actually needs a null check at every call site. This narrows once, here,
// instead of repeating an `if (!row) throw` in every `create*` function.
export function assertOne<T>(rows: T[], context: string): T {
  const [row] = rows;
  if (!row) {
    throw new Error(`Expected exactly one row from ${context}, got none`);
  }
  return row;
}
