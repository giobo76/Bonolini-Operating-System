import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: string, val: unknown) => ({ __op: "eq" as const, col, val }),
    and: (...conds: unknown[]) => ({ __op: "and" as const, conds }),
    desc: (col: string) => ({ __op: "desc" as const, col }),
    inArray: (col: string, vals: unknown[]) => ({ __op: "inArray" as const, col, vals }),
  };
});

type Cond =
  | { __op: "eq"; col: string; val: unknown }
  | { __op: "and"; conds: Cond[] }
  | { __op: "inArray"; col: string; vals: unknown[] };

function matches(row: Record<string, unknown>, cond: Cond): boolean {
  if (cond.__op === "and") return cond.conds.every((c) => matches(row, c));
  if (cond.__op === "inArray") return cond.vals.includes(row[cond.col]);
  return row[cond.col] === cond.val;
}

function sortDesc(rows: Record<string, unknown>[], desc?: { __op: "desc"; col: string }) {
  if (!desc) return rows;
  return [...rows].sort((a, b) => {
    const av = a[desc.col] as Date;
    const bv = b[desc.col] as Date;
    return bv.getTime() - av.getTime();
  });
}

function chain(rows: Record<string, unknown>[]) {
  const c = {
    where: (cond: Cond) => chain(rows.filter((r) => matches(r, cond))),
    orderBy: (desc: { __op: "desc"; col: string }) => chain(sortDesc(rows, desc)),
    limit: (n: number) => chain(rows.slice(0, n)),
    returning: async () => rows,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
    catch: (reject: (e: unknown) => unknown) => Promise.resolve(rows).catch(reject),
  };
  return c;
}

const { fakeState, evidenceTable } = vi.hoisted(() => ({
  fakeState: { rows: [] as Array<Record<string, unknown>>, nextId: 1 },
  evidenceTable: { __name: "evidence", id: "id", tenantId: "tenantId", collectedAt: "collectedAt" },
}));

vi.mock("@bos/db", () => ({
  evidence: evidenceTable,
  assertOne: <T,>(rows: T[], context: string): T => {
    const row = rows[0];
    if (!row) throw new Error(`Expected exactly one row from ${context}, got none`);
    return row;
  },
  getDb: () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        const row = { id: `evidence-${fakeState.nextId++}`, createdAt: new Date(), ...values };
        fakeState.rows.push(row);
        return chain([row]);
      },
    }),
    select: () => ({
      from: () => chain(fakeState.rows),
    }),
  }),
}));

const { createEvidence, getEvidence, listEvidence, getEvidenceByIds } = await import("./service");

beforeEach(() => {
  fakeState.rows = [];
  fakeState.nextId = 1;
});

describe("createEvidence / getEvidence", () => {
  it("creates a fact and reads it back within the same tenant", async () => {
    const created = await createEvidence("tenant-1", {
      source: "internal_db.bookings",
      rawObservation: { realConversions: 12 },
      conclusion: "12 real conversions this period",
      evidenceType: "fact",
      confidence: "high",
    });

    expect(created.evidenceType).toBe("fact");
    expect(created.confidence).toBe("high");

    const found = await getEvidence("tenant-1", created.id);
    expect(found?.conclusion).toBe("12 real conversions this period");
  });

  it("keeps evidenceType and confidence as two independent fields — never conflated", async () => {
    const created = await createEvidence("tenant-1", {
      source: "google_ads_api",
      rawObservation: { note: "measurement uncertain" },
      conclusion: "possible CPC anomaly, low-confidence reading",
      evidenceType: "recommendation",
      confidence: "low",
    });

    expect(created.evidenceType).toBe("recommendation");
    expect(created.confidence).toBe("low");
  });

  it("returns null for a cross-tenant read", async () => {
    const created = await createEvidence("tenant-1", {
      source: "internal_db.bookings",
      rawObservation: {},
      conclusion: "x",
      evidenceType: "fact",
      confidence: "high",
    });

    const found = await getEvidence("tenant-2", created.id);
    expect(found).toBeNull();
  });
});

describe("listEvidence", () => {
  it("lists only the requesting tenant's rows", async () => {
    await createEvidence("tenant-1", { source: "s", rawObservation: {}, conclusion: "a", evidenceType: "fact", confidence: "high" });
    await createEvidence("tenant-2", { source: "s", rawObservation: {}, conclusion: "b", evidenceType: "fact", confidence: "high" });

    const rows = await listEvidence("tenant-1", 20);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.conclusion).toBe("a");
  });
});

describe("getEvidenceByIds", () => {
  it("returns only tenant-owned rows among the requested ids, silently dropping the rest", async () => {
    const own = await createEvidence("tenant-1", { source: "s", rawObservation: {}, conclusion: "mine", evidenceType: "fact", confidence: "high" });
    const other = await createEvidence("tenant-2", { source: "s", rawObservation: {}, conclusion: "not mine", evidenceType: "fact", confidence: "high" });

    const rows = await getEvidenceByIds("tenant-1", [own.id, other.id, "does-not-exist"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(own.id);
  });

  it("returns an empty array for an empty id list without querying", async () => {
    const rows = await getEvidenceByIds("tenant-1", []);
    expect(rows).toEqual([]);
  });
});
