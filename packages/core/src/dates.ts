// Timestamps read through raw SQL (a `sql\`...\`` expression in a select, or
// db.execute) are NOT mapped to Date by drizzle: with postgres-js they come
// back as Postgres' own text, e.g. "2026-09-24 10:15:30.123+00". Only
// columns selected through the query builder are real Dates. Typing such a
// value as Date (sql<Date>) compiles fine and fails at runtime
// ("x.getTime is not a function") — the production bug of 2026-09-24.
//
// toValidDate accepts either shape and returns a valid Date or null, never
// an Invalid Date.

// Postgres timestamptz text: date, space or "T", time with optional
// fraction, offset as "+00", "+0200", "+02:00" or "Z".
const PG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/;

function normalizeOffset(offset: string | undefined): string {
  // No offset only happens for `timestamp without time zone`; every
  // timestamp in this schema is timestamptz, and the database runs in UTC.
  if (!offset || offset === "Z") return "Z";
  const sign = offset[0];
  const digits = offset.slice(1).replace(":", "");
  const hours = digits.slice(0, 2);
  const minutes = digits.slice(2, 4) || "00";
  return `${sign}${hours}:${minutes}`;
}

export function toValidDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;

  const text = value.trim();
  const match = PG_TIMESTAMP.exec(text);
  const date = match ? new Date(`${match[1]}T${match[2]}${normalizeOffset(match[3])}`) : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}
