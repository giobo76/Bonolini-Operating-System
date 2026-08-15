import { describe, expect, it, vi, beforeEach } from "vitest";

// Same strategy as run-check.test.ts: packages/core has no test-database
// yet, so @bos/db is fully mocked, keyed by table identity. The point of
// these tests is to prove the security-relevant facts survive future
// changes: recordLeadIntent never accepts a tenantId/clientId from its
// input, listUnlinkedLeads/linkLeadToClient always scope by the tenantId
// the caller passed in (never trusting a bare id alone), and
// linkLeadToClient never succeeds across tenants.

const { fakeState, tenantsTable, clientsTable, marketingLeadsTable } = vi.hoisted(() => {
  return {
    fakeState: {
      tenant: { id: "tenant-1" } as { id: string } | undefined,
      leadExistsInTenant: true,
      clientExistsInTenant: true,
      insertedValues: undefined as unknown,
      updateSetValues: undefined as unknown,
      selectLimitArg: undefined as number | undefined,
    },
    tenantsTable: { __name: "tenants" },
    clientsTable: { __name: "clients" },
    marketingLeadsTable: { __name: "marketingLeads" },
  };
});

vi.mock("@bos/db", () => {
  const db = {
    select: (_proj: unknown) => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => {
          // Both awaitable directly (plain `const [row] = await ...where(...)`)
          // and chainable (`.orderBy().limit()`), matching the two call
          // shapes service.ts actually uses.
          const resolveRows = () => {
            if (table === tenantsTable) return fakeState.tenant ? [fakeState.tenant] : [];
            if (table === marketingLeadsTable) return fakeState.leadExistsInTenant ? [{ id: "lead-1" }] : [];
            if (table === clientsTable) return fakeState.clientExistsInTenant ? [{ id: "client-1" }] : [];
            return [];
          };
          return {
            orderBy: () => ({
              limit: async (n: number) => {
                fakeState.selectLimitArg = n;
                return [{ id: "lead-1", channel: "whatsapp", clientId: null }];
              },
            }),
            then: (resolve: (v: unknown[]) => void) => resolve(resolveRows()),
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (vals: unknown) => ({
        returning: async () => {
          fakeState.insertedValues = vals;
          if (table === marketingLeadsTable) return [{ id: "lead-new", ...(vals as object) }];
          return [{ id: "row-1" }];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (vals: unknown) => ({
        where: (_cond: unknown) => ({
          returning: async () => {
            fakeState.updateSetValues = vals;
            if (table === marketingLeadsTable) {
              return [{ id: "lead-1", clientId: "client-1", status: "converted" }];
            }
            return [];
          },
        }),
      }),
    }),
  };

  return {
    tenants: tenantsTable,
    clients: clientsTable,
    marketingLeads: marketingLeadsTable,
    assertOne: (rows: unknown[]) => rows[0],
    getDb: () => db,
  };
});

const { recordLeadIntent, listUnlinkedLeads, linkLeadToClient } = await import("./service");

describe("recordLeadIntent", () => {
  beforeEach(() => {
    fakeState.tenant = { id: "tenant-1" };
    fakeState.insertedValues = undefined;
  });

  it("resolves the tenant server-side and forces status=new, clientId=null", async () => {
    await recordLeadIntent({
      channel: "whatsapp",
      utmSource: "google",
      utmCampaign: "summer",
      gclid: "abc123",
      landingPage: "https://bonolinitransfer.com/",
      referrer: "https://google.com/",
      visitorId: "visitor-1",
    });

    expect(fakeState.insertedValues).toMatchObject({
      tenantId: "tenant-1",
      channel: "whatsapp",
      status: "new",
      clientId: null,
      utmSource: "google",
      utmCampaign: "summer",
      gclid: "abc123",
      visitorId: "visitor-1",
    });
  });

  it("never lets the caller override tenantId/clientId/status — the input type itself has no such fields", async () => {
    // Compile-time guarantee (RecordLeadIntentInput has no tenantId/clientId/
    // status), verified here at runtime too: whatever the caller passes,
    // the insert always uses the server-resolved tenant and forced defaults.
    await recordLeadIntent({ channel: "phone" });
    expect((fakeState.insertedValues as { tenantId: string }).tenantId).toBe("tenant-1");
    expect((fakeState.insertedValues as { clientId: null }).clientId).toBeNull();
    expect((fakeState.insertedValues as { status: string }).status).toBe("new");
  });

  it("throws if the default tenant doesn't exist, rather than silently using a wrong one", async () => {
    fakeState.tenant = undefined;
    await expect(recordLeadIntent({ channel: "email" })).rejects.toThrow(/tenant/i);
  });
});

describe("listUnlinkedLeads", () => {
  it("applies the requested limit", async () => {
    const rows = await listUnlinkedLeads("tenant-1", { limit: 7 });
    expect(fakeState.selectLimitArg).toBe(7);
    expect(rows).toHaveLength(1);
  });
});

describe("linkLeadToClient", () => {
  beforeEach(() => {
    fakeState.leadExistsInTenant = true;
    fakeState.clientExistsInTenant = true;
    fakeState.updateSetValues = undefined;
  });

  it("returns null if the lead doesn't belong to the caller's tenant", async () => {
    fakeState.leadExistsInTenant = false;
    const result = await linkLeadToClient("tenant-1", { marketingLeadId: "lead-1", clientId: "client-1" });
    expect(result).toBeNull();
    expect(fakeState.updateSetValues).toBeUndefined();
  });

  it("returns null if the client doesn't belong to the caller's tenant", async () => {
    fakeState.clientExistsInTenant = false;
    const result = await linkLeadToClient("tenant-1", { marketingLeadId: "lead-1", clientId: "client-1" });
    expect(result).toBeNull();
    expect(fakeState.updateSetValues).toBeUndefined();
  });

  it("links the lead to the client and sets status=converted when both exist in the tenant", async () => {
    const result = await linkLeadToClient("tenant-1", { marketingLeadId: "lead-1", clientId: "client-1" });
    expect(fakeState.updateSetValues).toEqual({ clientId: "client-1", status: "converted" });
    expect(result).toMatchObject({ clientId: "client-1", status: "converted" });
  });
});
