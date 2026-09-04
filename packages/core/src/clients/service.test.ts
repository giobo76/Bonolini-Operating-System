import { StringChunk } from "drizzle-orm";
import { describe, expect, it, beforeEach, vi } from "vitest";

// @bos/db fully mocked — same raw-execute() mocking technique already
// established in packages/core/src/bookings/service.test.ts and
// packages/core/src/transfer-requests/service.test.ts: filter out
// StringChunk (literal SQL text) from the drizzle sql`` template's
// queryChunks to read back the bound parameters in order.
const { fakeState, clientsTable } = vi.hoisted(() => {
  return {
    fakeState: { clients: [] as Array<Record<string, unknown>>, nextId: 1 },
    clientsTable: { __name: "clients" },
  };
});

function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

vi.mock("@bos/db", () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () =>
            Promise.resolve(
              [...fakeState.clients].sort(
                (a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime(),
              ),
            ),
        }),
      }),
    }),
    execute: async (query: { queryChunks: unknown[] }) => {
      const params = query.queryChunks.filter((chunk) => !(chunk instanceof StringChunk));
      const [tenantId, fullName, phone, firstTouchAt, gclid, utmSource, utmCampaign] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
      ];

      const normalized = normalizePhone(phone);
      const conflict = fakeState.clients.some(
        (c) => c.tenantId === tenantId && normalizePhone(c.phone as string) === normalized && !c.deletedAt,
      );
      if (conflict) return [];

      const row: Record<string, unknown> = {
        id: `client-${fakeState.nextId++}`,
        tenantId,
        profileId: null,
        customerType: "private",
        fullName,
        companyName: null,
        email: null,
        phone: normalized,
        country: null,
        preferredLanguage: null,
        notes: null,
        marketingConsent: false,
        utmSource: utmSource ?? null,
        utmMedium: null,
        utmCampaign: utmCampaign ?? null,
        utmTerm: null,
        utmContent: null,
        gclid: gclid ?? null,
        landingPage: null,
        referrer: null,
        firstTouchAt: new Date(firstTouchAt),
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      fakeState.clients.push(row);
      return [row];
    },
  };

  return {
    clients: clientsTable,
    getDb: () => db,
  };
});

const { findOrCreateClientByPhone, findClientByPhone, normalizeClientPhone } = await import("./service");

beforeEach(() => {
  fakeState.clients = [];
  fakeState.nextId = 1;
});

describe("normalizeClientPhone", () => {
  it("strips every non-digit character", () => {
    expect(normalizeClientPhone("+39 333 123-4567")).toBe("393331234567");
  });
});

describe("findOrCreateClientByPhone", () => {
  it("creates a new client when no matching phone exists yet", async () => {
    const client = await findOrCreateClientByPhone(
      "tenant-1",
      "+39 333 1234567",
      "Mario Rossi",
      new Date("2026-09-01T10:00:00Z"),
    );

    expect(client.fullName).toBe("Mario Rossi");
    expect(client.phone).toBe("393331234567");
    expect(fakeState.clients).toHaveLength(1);
  });

  it("is idempotent — a second call with the same (normalized) phone returns the existing client, never a duplicate", async () => {
    const first = await findOrCreateClientByPhone("tenant-1", "333-1234567", "Mario Rossi", new Date());
    const second = await findOrCreateClientByPhone("tenant-1", "333 1234567", "Someone Else", new Date());

    expect(fakeState.clients).toHaveLength(1);
    expect(second.id).toBe(first.id);
    // The second call's fullName is discarded, not applied on top of the
    // existing row — this function never overwrites an existing client.
    expect(second.fullName).toBe("Mario Rossi");
  });

  it("stores attribution (gclid/utmSource/utmCampaign) only on a brand-new client", async () => {
    const client = await findOrCreateClientByPhone("tenant-1", "3331234567", "Mario Rossi", new Date(), {
      gclid: "Cj0KEQjw_test",
      utmSource: "google",
      utmCampaign: "summer24",
    });

    expect(client.gclid).toBe("Cj0KEQjw_test");
    expect(client.utmSource).toBe("google");
    expect(client.utmCampaign).toBe("summer24");
  });

  it("never overwrites an existing client's attribution on a repeated call", async () => {
    await findOrCreateClientByPhone("tenant-1", "3331234567", "Mario Rossi", new Date(), { gclid: "first-gclid" });
    const second = await findOrCreateClientByPhone("tenant-1", "3331234567", "Mario Rossi", new Date(), {
      gclid: "different-gclid",
    });

    expect(second.gclid).toBe("first-gclid");
  });
});

describe("findClientByPhone", () => {
  it("finds an existing client regardless of phone formatting differences", async () => {
    await findOrCreateClientByPhone("tenant-1", "+39 333 123 4567", "Mario Rossi", new Date());

    const found = await findClientByPhone("tenant-1", "3331234567");
    expect(found?.fullName).toBe("Mario Rossi");
  });

  it("returns null when no client matches the phone", async () => {
    const found = await findClientByPhone("tenant-1", "0000000000");
    expect(found).toBeNull();
  });
});
