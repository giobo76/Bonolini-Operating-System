import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: string, val: unknown) => ({ __eq: true, col, val }),
    and: (...conds: unknown[]) => ({ __and: true, conds }),
    desc: (col: string) => ({ __desc: true, col }),
  };
});

type Cond = { __eq: true; col: string; val: unknown } | { __and: true; conds: Cond[] };

function matches(row: Record<string, unknown>, cond: Cond): boolean {
  if ("__and" in cond) return cond.conds.every((c) => matches(row, c));
  return row[cond.col] === cond.val;
}

const { fakeState, agentRunsTable } = vi.hoisted(() => ({
  fakeState: { rows: [] as Array<Record<string, unknown>>, nextId: 1 },
  agentRunsTable: { id: "id", tenantId: "tenantId", agentName: "agentName", startedAt: "startedAt" },
}));

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  return { limit: () => promise, orderBy: () => thenable(rows), then: promise.then.bind(promise), catch: promise.catch.bind(promise) };
}

vi.mock("@bos/db", () => ({
  agentRuns: agentRunsTable,
  assertOne: <T,>(rows: T[], context: string): T => {
    const row = rows[0];
    if (!row) throw new Error(`Expected exactly one row from ${context}, got none`);
    return row;
  },
  getDb: () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          const row = { id: `run-${fakeState.nextId++}`, startedAt: new Date(), completedAt: null, ...values };
          fakeState.rows.push(row);
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (cond: Cond) => ({
          returning: async () => {
            const idx = fakeState.rows.findIndex((row) => matches(row, cond));
            if (idx < 0) return [];
            fakeState.rows[idx] = { ...fakeState.rows[idx], ...patch };
            return [fakeState.rows[idx]];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: (cond: Cond) => thenable(fakeState.rows.filter((row) => matches(row, cond))),
      }),
    }),
  }),
}));

const { createRun, updateRun, completeRun, getRun, listRuns } = await import("./audit");

beforeEach(() => {
  fakeState.rows = [];
  fakeState.nextId = 1;
});

describe("createRun", () => {
  it("creates a run in 'running' status with the given input recorded", async () => {
    const run = await createRun({ tenantId: "tenant-1", agentName: "marketing", trigger: "manual", input: { foo: "bar" } });

    expect(run.status).toBe("running");
    expect(run.agentName).toBe("marketing");
    expect(run.input).toEqual({ foo: "bar" });
  });
});

describe("updateRun / completeRun", () => {
  it("records perception/decision via updateRun without changing status", async () => {
    const run = await createRun({ tenantId: "tenant-1", agentName: "marketing", trigger: "manual", input: {} });
    const updated = await updateRun("tenant-1", run.id, { perception: { a: 1 }, decision: { b: 2 } });

    expect(updated.perception).toEqual({ a: 1 });
    expect(updated.decision).toEqual({ b: 2 });
    expect(updated.status).toBe("running");
  });

  it("marks a run completed with the given status and completedAt", async () => {
    const run = await createRun({ tenantId: "tenant-1", agentName: "marketing", trigger: "manual", input: {} });
    const completed = await completeRun("tenant-1", run.id, "success");

    expect(completed.status).toBe("success");
    expect(completed.completedAt).toBeInstanceOf(Date);
  });

  it("never updates a run belonging to a different tenant", async () => {
    const run = await createRun({ tenantId: "tenant-1", agentName: "marketing", trigger: "manual", input: {} });

    await expect(completeRun("tenant-2", run.id, "success")).rejects.toThrow();
  });
});

describe("getRun / listRuns", () => {
  it("returns null for a run that doesn't exist", async () => {
    expect(await getRun("tenant-1", "nonexistent")).toBeNull();
  });

  it("returns a run scoped to its own tenant", async () => {
    const run = await createRun({ tenantId: "tenant-1", agentName: "social", trigger: "cron", input: {} });
    expect(await getRun("tenant-1", run.id)).toMatchObject({ id: run.id });
  });

  it("never returns another tenant's run even by the correct id", async () => {
    const run = await createRun({ tenantId: "tenant-1", agentName: "social", trigger: "cron", input: {} });
    expect(await getRun("tenant-2", run.id)).toBeNull();
  });

  it("lists only the calling tenant's runs", async () => {
    await createRun({ tenantId: "tenant-1", agentName: "marketing", trigger: "manual", input: {} });
    await createRun({ tenantId: "tenant-2", agentName: "marketing", trigger: "manual", input: {} });

    const runs = await listRuns("tenant-1");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.tenantId).toBe("tenant-1");
  });
});
