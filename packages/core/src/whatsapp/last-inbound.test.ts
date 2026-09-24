import { describe, expect, it, vi, beforeEach } from "vitest";

// getLastInboundReceivedAt must return a real Date (or null) whatever shape
// the driver hands back. The rows here are what postgres-js returns for a
// raw timestamptz: Postgres' own text, not a Date.

const { state } = vi.hoisted(() => ({ state: { rows: [] as Array<{ receivedAt: unknown }> } }));

vi.mock("@bos/db", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => state.rows,
  };
  return {
    getDb: () => ({ select: () => chain }),
    clients: {},
    whatsappMessages: {},
    tenants: {},
    assertOne: (rows: unknown[]) => rows[0],
  };
});

vi.mock("../marketing", () => ({ confirmLeadByContactToken: vi.fn() }));

const { getLastInboundReceivedAt } = await import("./service");

beforeEach(() => {
  state.rows = [];
});

describe("getLastInboundReceivedAt", () => {
  it("returns a Date when the driver gives Postgres timestamp text", async () => {
    state.rows = [{ receivedAt: "2026-09-24 10:15:30.123+00" }];
    const result = await getLastInboundReceivedAt("tenant-1", "client-1");
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe("2026-09-24T10:15:30.123Z");
    expect(typeof result?.getTime()).toBe("number");
  });

  it("returns the Date as-is when the driver already mapped it", async () => {
    state.rows = [{ receivedAt: new Date("2026-09-24T10:15:30.123Z") }];
    expect((await getLastInboundReceivedAt("tenant-1", "client-1"))?.toISOString()).toBe("2026-09-24T10:15:30.123Z");
  });

  it("returns null when the client never wrote, or the value is unreadable", async () => {
    expect(await getLastInboundReceivedAt("tenant-1", "client-1")).toBeNull();
    state.rows = [{ receivedAt: "garbage" }];
    expect(await getLastInboundReceivedAt("tenant-1", "client-1")).toBeNull();
  });
});
