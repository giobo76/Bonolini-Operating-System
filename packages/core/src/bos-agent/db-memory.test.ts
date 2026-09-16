import { describe, expect, it, vi, beforeEach } from "vitest";

// drizzle-orm's real eq()/and() encode conditions into a SQL AST that's
// fragile to decode generically for a 3-column compound condition (see
// transfer-requests/service.test.ts's own comment on why it only decodes a
// single plain eq()) — so this file replaces just eq()/and() with small
// tagged objects a local fake getDb() can evaluate directly, keeping every
// other drizzle-orm export (including `sql`, used by db-memory.ts's own
// increment) real and untouched.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: string, val: unknown) => ({ __eq: true, col, val }),
    and: (...conds: unknown[]) => ({ __and: true, conds }),
  };
});

type Cond = { __eq: true; col: string; val: unknown } | { __and: true; conds: Cond[] };

function matches(row: Record<string, unknown>, cond: Cond): boolean {
  if ("__and" in cond) return cond.conds.every((c) => matches(row, c));
  return row[cond.col] === cond.val;
}

const { fakeState, agentMemoryTable } = vi.hoisted(() => ({
  fakeState: { rows: [] as Array<Record<string, unknown>> },
  agentMemoryTable: { tenantId: "tenantId", namespace: "namespace", key: "key", version: "version" },
}));

vi.mock("@bos/db", () => ({
  agentMemory: agentMemoryTable,
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (cond: Cond) => Promise.resolve(fakeState.rows.filter((row) => matches(row, cond))),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => {
          const idx = fakeState.rows.findIndex(
            (row) => row.tenantId === values.tenantId && row.namespace === values.namespace && row.key === values.key,
          );
          if (idx >= 0) {
            fakeState.rows[idx] = { ...fakeState.rows[idx], value: values.value, updatedAt: new Date() };
          } else {
            fakeState.rows.push({ ...values, version: 1, updatedAt: new Date() });
          }
        },
      }),
    }),
    delete: () => ({
      where: (cond: Cond) => ({
        returning: async () => {
          const before = fakeState.rows.length;
          fakeState.rows = fakeState.rows.filter((row) => !matches(row, cond));
          return fakeState.rows.length < before ? [{ deleted: true }] : [];
        },
      }),
    }),
  }),
}));

const { DbSharedMemory } = await import("./db-memory");

beforeEach(() => {
  fakeState.rows = [];
});

describe("DbSharedMemory — basic get/set/delete/list", () => {
  it("returns undefined for a key that was never set", async () => {
    const memory = new DbSharedMemory("tenant-1");
    expect(await memory.get("ns", "k1")).toBeUndefined();
  });

  it("returns what was set, with a timestamp", async () => {
    const memory = new DbSharedMemory("tenant-1");
    await memory.set("ns", "k1", { hello: "world" });

    const entry = await memory.get("ns", "k1");
    expect(entry?.value).toEqual({ hello: "world" });
    expect(entry?.updatedAt).toBeTruthy();
  });

  it("overwrites an existing key on a second set, rather than duplicating it", async () => {
    const memory = new DbSharedMemory("tenant-1");
    await memory.set("ns", "k1", { v: 1 });
    await memory.set("ns", "k1", { v: 2 });

    expect(await memory.get("ns", "k1")).toMatchObject({ value: { v: 2 } });
    expect(fakeState.rows).toHaveLength(1);
  });

  it("deletes an existing key and reports true; deleting again reports false", async () => {
    const memory = new DbSharedMemory("tenant-1");
    await memory.set("ns", "k1", { v: 1 });

    expect(await memory.delete("ns", "k1")).toBe(true);
    expect(await memory.delete("ns", "k1")).toBe(false);
    expect(await memory.get("ns", "k1")).toBeUndefined();
  });

  it("lists every key in a namespace, keyed by key", async () => {
    const memory = new DbSharedMemory("tenant-1");
    await memory.set("ns", "k1", { v: 1 });
    await memory.set("ns", "k2", { v: 2 });

    const listed = await memory.list("ns");
    expect(Object.keys(listed).sort()).toEqual(["k1", "k2"]);
    expect(listed.k1?.value).toEqual({ v: 1 });
  });
});

describe("DbSharedMemory — tenant isolation", () => {
  it("never lets one tenant read another tenant's value for the same namespace/key", async () => {
    const tenantA = new DbSharedMemory("tenant-a");
    const tenantB = new DbSharedMemory("tenant-b");

    await tenantA.set("ns", "shared-key", { secret: "tenant-a-value" });

    expect(await tenantB.get("ns", "shared-key")).toBeUndefined();
    expect(await tenantA.get("ns", "shared-key")).toMatchObject({ value: { secret: "tenant-a-value" } });
  });

  it("never lets one tenant delete another tenant's value for the same namespace/key", async () => {
    const tenantA = new DbSharedMemory("tenant-a");
    const tenantB = new DbSharedMemory("tenant-b");

    await tenantA.set("ns", "shared-key", { v: 1 });

    expect(await tenantB.delete("ns", "shared-key")).toBe(false);
    expect(await tenantA.get("ns", "shared-key")).toBeDefined();
  });

  it("never lets one tenant's list() surface another tenant's keys in the same namespace", async () => {
    const tenantA = new DbSharedMemory("tenant-a");
    const tenantB = new DbSharedMemory("tenant-b");

    await tenantA.set("ns", "a-key", { v: "a" });
    await tenantB.set("ns", "b-key", { v: "b" });

    expect(Object.keys(await tenantA.list("ns"))).toEqual(["a-key"]);
    expect(Object.keys(await tenantB.list("ns"))).toEqual(["b-key"]);
  });
});
