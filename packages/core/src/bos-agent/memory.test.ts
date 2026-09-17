import { describe, expect, it, vi, beforeEach } from "vitest";

// DbSharedMemory's own tenant isolation is already directly tested in
// db-memory.test.ts — this file mocks it to test memory.ts's own added
// value in isolation: schema validation, bounded search, rolling-history
// bounding.
const dbMemoryMock = vi.hoisted(() => {
  const stores = new Map<string, Map<string, { value: unknown; updatedAt: string }>>();
  return {
    stores,
    reset: () => stores.clear(),
  };
});

vi.mock("./db-memory", () => ({
  DbSharedMemory: class {
    constructor(private tenantId: string) {}
    private bucket(namespace: string) {
      const key = `${this.tenantId}:${namespace}`;
      let b = dbMemoryMock.stores.get(key);
      if (!b) {
        b = new Map();
        dbMemoryMock.stores.set(key, b);
      }
      return b;
    }
    async get(namespace: string, key: string) {
      return this.bucket(namespace).get(key);
    }
    async set(namespace: string, key: string, value: unknown) {
      this.bucket(namespace).set(key, { value, updatedAt: new Date().toISOString() });
    }
    async delete(namespace: string, key: string) {
      return this.bucket(namespace).delete(key);
    }
    async list(namespace: string) {
      return Object.fromEntries(this.bucket(namespace).entries());
    }
  },
}));

const { memoryGet, memorySet, memoryUpdate, memorySearch, pushBounded, MAX_ROLLING_HISTORY } = await import("./memory");

beforeEach(() => {
  dbMemoryMock.reset();
});

describe("memorySet / memoryGet", () => {
  it("round-trips a valid record with a createdAt timestamp added automatically", async () => {
    await memorySet("tenant-1", "marketing", "last-assessment", {
      kind: "decision",
      agentName: "marketing",
      summary: "Conversions look healthy.",
    });

    const record = await memoryGet("tenant-1", "marketing", "last-assessment");
    expect(record?.summary).toBe("Conversions look healthy.");
    expect(record?.createdAt).toBeTruthy();
  });

  it("throws on write when the record fails schema validation (e.g. summary too long)", async () => {
    await expect(
      memorySet("tenant-1", "marketing", "bad", {
        kind: "decision",
        agentName: "marketing",
        summary: "x".repeat(500),
      }),
    ).rejects.toThrow();
  });

  it("returns undefined, never a raw unvalidated blob, for a corrupted stored value", async () => {
    const { DbSharedMemory } = await import("./db-memory");
    const memory = new DbSharedMemory("tenant-1");
    await memory.set("marketing", "corrupt", { not: "a valid record" });

    expect(await memoryGet("tenant-1", "marketing", "corrupt")).toBeUndefined();
  });

  it("returns undefined for a key that was never set", async () => {
    expect(await memoryGet("tenant-1", "marketing", "nonexistent")).toBeUndefined();
  });

  it("redacts secret-shaped keys in `data` before persisting, same as observability.ts's log redaction", async () => {
    await memorySet("tenant-1", "marketing", "leaky", {
      kind: "context",
      agentName: "marketing",
      summary: "should never carry a real secret",
      data: { apiToken: "sk-real-secret-value", safeField: "kept as-is" },
    });

    const record = await memoryGet("tenant-1", "marketing", "leaky");
    expect(record?.data?.apiToken).toBe("[redacted]");
    expect(record?.data?.safeField).toBe("kept as-is");
  });
});

describe("memoryUpdate", () => {
  it("merges a partial patch onto the existing record", async () => {
    await memorySet("tenant-1", "social", "post:2026-09-07", {
      kind: "decision",
      agentName: "social",
      summary: "Facebook failed, retry proposed.",
      data: { postId: "p1" },
    });

    const updated = await memoryUpdate("tenant-1", "social", "post:2026-09-07", { summary: "Retry approved and executed." });

    expect(updated.summary).toBe("Retry approved and executed.");
    expect(updated.data).toEqual({ postId: "p1" });
  });

  it("creates a new record from just the patch when nothing existed before", async () => {
    const created = await memoryUpdate("tenant-1", "social", "brand-new", { kind: "context", summary: "first write" });
    expect(created.summary).toBe("first write");
    expect(created.agentName).toBe("unknown");
  });
});

describe("memorySearch — bounded, namespace-scoped", () => {
  it("returns every record in the namespace up to the default cap", async () => {
    for (let i = 0; i < 5; i++) {
      await memorySet("tenant-1", "operations", `request:${i}`, { kind: "context", agentName: "operations", summary: `req ${i}` });
    }

    const results = await memorySearch("tenant-1", "operations");
    expect(results).toHaveLength(5);
  });

  it("never returns more than the hard cap even if a larger limit is requested", async () => {
    for (let i = 0; i < 30; i++) {
      await memorySet("tenant-1", "operations", `request:${i}`, { kind: "context", agentName: "operations", summary: `req ${i}` });
    }

    const results = await memorySearch("tenant-1", "operations", { limit: 1000 });
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it("applies a caller-supplied filter", async () => {
    await memorySet("tenant-1", "marketing", "open-1", { kind: "open_issue", agentName: "marketing", summary: "issue A" });
    await memorySet("tenant-1", "marketing", "resolved-1", { kind: "resolved_issue", agentName: "marketing", summary: "issue B" });

    const openOnly = await memorySearch("tenant-1", "marketing", { filter: (r) => r.kind === "open_issue" });
    expect(openOnly).toHaveLength(1);
    expect(openOnly[0]?.summary).toBe("issue A");
  });

  it("never returns records from a different namespace", async () => {
    await memorySet("tenant-1", "marketing", "a", { kind: "context", agentName: "marketing", summary: "in marketing" });
    await memorySet("tenant-1", "social", "b", { kind: "context", agentName: "social", summary: "in social" });

    const marketingResults = await memorySearch("tenant-1", "marketing");
    expect(marketingResults).toHaveLength(1);
    expect(marketingResults[0]?.summary).toBe("in marketing");
  });
});

describe("pushBounded — rolling history never grows unbounded", () => {
  it("appends under the cap normally", () => {
    expect(pushBounded(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("drops the oldest entries once the cap is exceeded", () => {
    const list = Array.from({ length: MAX_ROLLING_HISTORY }, (_, i) => `item-${i}`);
    const result = pushBounded(list, "new-item");

    expect(result).toHaveLength(MAX_ROLLING_HISTORY);
    expect(result[0]).toBe("item-1");
    expect(result[result.length - 1]).toBe("new-item");
  });

  it("starts a fresh list when none existed", () => {
    expect(pushBounded(undefined, "first")).toEqual(["first"]);
  });
});
