import { StringChunk } from "drizzle-orm";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExtractedWhatsappMessage } from "./schema";

// @bos/db is fully mocked, same convention as
// packages/core/src/marketing/run-check.test.ts (no test-database strategy
// exists yet — see docs/PRODUCTION_ROADMAP.md Milestone 3).
//
// PRE-COMMIT FIX: findOrCreateClientByPhone now does a raw
// `db.execute(sql\`insert ... on conflict ... do nothing returning *\`)`
// (see service.ts) instead of a plain SELECT-then-INSERT, to make "one
// client per phone" atomic at the Postgres level. The fake `execute` below
// reads the bound parameters back out of the drizzle SQL object's
// queryChunks (everything that isn't a `StringChunk` — drizzle's tagged
// template embeds interpolated primitives directly, not wrapped — in the
// exact order service.ts's template interpolates them) and applies the
// same tenant+normalized-phone uniqueness semantics the real partial unique
// index (0009_clients_phone_unique_per_tenant.sql) enforces, so tests can
// exercise the find-vs-create branching without a real database. This
// cannot prove true concurrent-transaction atomicity (no test-database
// strategy exists for that) — it verifies the code path's outcome logic,
// not Postgres's own guarantee.

const { fakeState, tenantsTable, clientsTable, whatsappMessagesTable } = vi.hoisted(() => {
  return {
    fakeState: {
      tenant: { id: "tenant-1" },
      clients: [] as Array<Record<string, unknown>>,
      whatsappMessages: [] as Array<Record<string, unknown>>,
      insertedClients: [] as Array<Record<string, unknown>>,
      updateCalls: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
      nextClientId: 1,
      nextMessageId: 1,
    },
    tenantsTable: { __name: "tenants" },
    clientsTable: { __name: "clients" },
    whatsappMessagesTable: { __name: "whatsappMessages" },
  };
});

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  return {
    orderBy: () => promise,
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => promise.then(resolve, reject),
    catch: (reject: (e: unknown) => void) => promise.catch(reject),
  };
}

function normalizePhoneForMock(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

vi.mock("@bos/db", () => {
  const db = {
    select: (_cols?: unknown) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === tenantsTable) return thenable([fakeState.tenant]);
          if (table === clientsTable) return thenable(fakeState.clients);
          if (table === whatsappMessagesTable) return thenable(fakeState.whatsappMessages);
          return thenable([]);
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            const exists = fakeState.whatsappMessages.some(
              (m) => m.tenantId === vals.tenantId && m.whatsappMessageId === vals.whatsappMessageId,
            );
            if (exists) return [];
            const row = { id: `msg-${fakeState.nextMessageId++}`, clientId: null, parsed: null, ...vals };
            fakeState.whatsappMessages.push(row);
            return [row];
          },
        }),
        returning: async () => {
          throw new Error("unexpected plain insert().returning() without onConflictDoNothing in this mock");
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          fakeState.updateCalls.push({ table, values });
          return [];
        },
      }),
    }),
    // Backs findOrCreateClientByPhone's atomic `INSERT ... ON CONFLICT ...
    // DO NOTHING RETURNING *` against clients. Params are bound in the
    // exact order service.ts's template interpolates them: [tenantId,
    // fullName, normalizedPhone, receivedAt].
    execute: async (query: { queryChunks: unknown[] }) => {
      const params = query.queryChunks.filter((chunk) => !(chunk instanceof StringChunk));
      const [tenantId, fullName, normalizedPhone, receivedAt] = params as [string, string, string, Date];

      const conflicting = fakeState.clients.find(
        (c) => c.tenantId === tenantId && !c.deletedAt && normalizePhoneForMock(c.phone as string) === normalizedPhone,
      );
      if (conflicting) return [];

      const row = {
        id: `client-${fakeState.nextClientId++}`,
        tenantId,
        customerType: "private",
        fullName,
        phone: normalizedPhone,
        email: null,
        preferredLanguage: null,
        marketingConsent: false,
        firstTouchAt: receivedAt,
        deletedAt: null,
      };
      fakeState.clients.push(row);
      fakeState.insertedClients.push(row);
      return [row];
    },
  };

  return {
    tenants: tenantsTable,
    clients: clientsTable,
    whatsappMessages: whatsappMessagesTable,
    assertOne: (rows: unknown[]) => rows[0],
    getDb: () => db,
  };
});

const parseWhatsappMessage = vi.fn();
vi.mock("./parser", () => ({ parseWhatsappMessage: (...args: unknown[]) => parseWhatsappMessage(...args) }));

const { processInboundMessage, normalizePhone } = await import("./service");

function inboundMessage(overrides: Partial<ExtractedWhatsappMessage> = {}): ExtractedWhatsappMessage {
  return {
    waMessageId: "wamid.ABC123",
    fromPhone: "393281234567",
    type: "text",
    rawText: "Hi, I need a transfer from Milan to Tirano tomorrow for 4 people",
    profileName: null,
    receivedAt: new Date("2026-08-18T10:00:00Z"),
    ...overrides,
  };
}

describe("normalizePhone", () => {
  it("strips everything but digits", () => {
    expect(normalizePhone("+39 328 123-4567")).toBe("393281234567");
    expect(normalizePhone("393281234567")).toBe("393281234567");
  });
});

describe("processInboundMessage", () => {
  beforeEach(() => {
    fakeState.tenant = { id: "tenant-1" };
    fakeState.clients = [];
    fakeState.whatsappMessages = [];
    fakeState.insertedClients = [];
    fakeState.updateCalls = [];
    fakeState.nextClientId = 1;
    fakeState.nextMessageId = 1;
    parseWhatsappMessage.mockReset();
    parseWhatsappMessage.mockResolvedValue({});
  });

  // 1 / 8. duplicate whatsapp_message_id -> a single row, nothing new written
  it("1/8: a duplicate whatsapp_message_id returns the existing row and writes nothing new", async () => {
    fakeState.whatsappMessages = [
      {
        id: "msg-existing",
        tenantId: "tenant-1",
        whatsappMessageId: "wamid.ABC123",
        clientId: "client-existing",
        parsed: { pickup: "Milan" },
        rawText: "orig",
      },
    ];

    const result = await processInboundMessage(inboundMessage());

    expect(result).toEqual({ status: "duplicate", tenantId: "tenant-1", messageId: "msg-existing", clientId: "client-existing", parsed: { pickup: "Milan" } });
    expect(fakeState.whatsappMessages).toHaveLength(1);
    expect(fakeState.insertedClients).toHaveLength(0);
  });

  // 2. duplicate whatsapp_message_id -> Claude is never called again
  it("2: a duplicate whatsapp_message_id never triggers a second parseWhatsappMessage call", async () => {
    fakeState.whatsappMessages = [
      { id: "msg-existing", tenantId: "tenant-1", whatsappMessageId: "wamid.ABC123", clientId: "client-existing", parsed: {}, rawText: "orig" },
    ];

    await processInboundMessage(inboundMessage());

    expect(parseWhatsappMessage).not.toHaveBeenCalled();
  });

  // 3. same phone, different message_id -> same client (sequential outcome)
  it("3: two messages with different message_id but the same phone resolve to the same client", async () => {
    const first = await processInboundMessage(inboundMessage({ waMessageId: "wamid.ONE", profileName: "Mario Rossi" }));
    const second = await processInboundMessage(inboundMessage({ waMessageId: "wamid.TWO" }));

    expect(first.clientId).toBe(second.clientId);
    expect(fakeState.insertedClients).toHaveLength(1);
  });

  it("3b: an existing client with a differently-formatted matching phone is found, not duplicated", async () => {
    fakeState.clients = [
      { id: "client-9", tenantId: "tenant-1", phone: "+39 328 123 4567", email: null, preferredLanguage: null, deletedAt: null },
    ];

    const result = await processInboundMessage(inboundMessage({ fromPhone: "393281234567" }));

    expect(result.clientId).toBe("client-9");
    expect(fakeState.insertedClients).toHaveLength(0);
  });

  // 4. "concurrency" outcome: findOrCreateClientByPhone's conflict branch
  // is exercised directly by pre-seeding a client that a "concurrent"
  // insert would have raced against — proves the atomic INSERT...ON
  // CONFLICT path reads back the existing row instead of creating a
  // second one, without needing a real concurrent-transaction test (no
  // test-database strategy exists for that in this repo).
  it("4: when a matching client already exists at insert time (simulating the losing side of a race), no second client is created", async () => {
    fakeState.clients = [
      { id: "client-winner", tenantId: "tenant-1", phone: "393281234567", email: null, preferredLanguage: null, deletedAt: null },
    ];

    const result = await processInboundMessage(inboundMessage({ waMessageId: "wamid.LOSER" }));

    expect(result.clientId).toBe("client-winner");
    expect(fakeState.insertedClients).toHaveLength(0);
  });

  // 5. different tenants + same whatsapp_message_id -> distinct messages
  it("5: the same whatsapp_message_id from two different tenants produces two distinct message rows", async () => {
    fakeState.tenant = { id: "tenant-A" };
    const first = await processInboundMessage(inboundMessage({ waMessageId: "wamid.SHARED" }));

    fakeState.tenant = { id: "tenant-B" };
    const second = await processInboundMessage(inboundMessage({ waMessageId: "wamid.SHARED" }));

    expect(first.status).toBe("processed");
    expect(second.status).toBe("processed");
    expect(first.messageId).not.toBe(second.messageId);
    expect(fakeState.whatsappMessages).toHaveLength(2);
    expect(fakeState.whatsappMessages.map((m) => m.tenantId)).toEqual(["tenant-A", "tenant-B"]);
  });

  it("10: creates a new client when no existing client matches the phone", async () => {
    const result = await processInboundMessage(inboundMessage({ profileName: "Mario Rossi" }));

    expect(fakeState.insertedClients).toHaveLength(1);
    expect(fakeState.insertedClients[0]).toMatchObject({ fullName: "Mario Rossi", phone: "393281234567" });
    expect(result.clientId).toBe(fakeState.insertedClients[0]!.id);
  });

  it("falls back to the phone number as fullName when WhatsApp provides no profile name", async () => {
    await processInboundMessage(inboundMessage({ profileName: null }));

    expect(fakeState.insertedClients[0]).toMatchObject({ fullName: "393281234567" });
  });

  it("11: the same message delivered twice (retry) never creates a second client", async () => {
    await processInboundMessage(inboundMessage());
    await processInboundMessage(inboundMessage());

    expect(fakeState.insertedClients).toHaveLength(1);
    expect(fakeState.whatsappMessages).toHaveLength(1);
  });

  it("12: raw_text is stored verbatim, exactly as received", async () => {
    const text = "Hi, I need a transfer from Milan to Tirano tomorrow for 4 people";
    await processInboundMessage(inboundMessage({ rawText: text }));

    expect(fakeState.whatsappMessages[0]!.rawText).toBe(text);
  });

  it("13: the parser's output is persisted onto the message row", async () => {
    parseWhatsappMessage.mockResolvedValue({ pickup: "Milan", destination: "Tirano", passengers: 4 });

    await processInboundMessage(inboundMessage());

    const messageUpdate = fakeState.updateCalls.find((c) => c.table === whatsappMessagesTable);
    expect(messageUpdate?.values.parsed).toEqual({ pickup: "Milan", destination: "Tirano", passengers: 4 });
  });

  it("never calls the parser for non-text messages, but still links the client", async () => {
    const result = await processInboundMessage(inboundMessage({ type: "image", rawText: null }));

    expect(parseWhatsappMessage).not.toHaveBeenCalled();
    expect(result.clientId).not.toBeNull();
    expect(fakeState.whatsappMessages[0]!.rawText).toContain("image");
  });

  it("never overwrites an existing client's email/language, only fills them when empty", async () => {
    fakeState.clients = [
      { id: "client-existing", tenantId: "tenant-1", phone: "393281234567", email: "already@set.com", preferredLanguage: null, deletedAt: null },
    ];
    parseWhatsappMessage.mockResolvedValue({ email: "new@fromtext.com", language: "it" });

    await processInboundMessage(inboundMessage());

    const clientUpdate = fakeState.updateCalls.find((c) => c.table === clientsTable);
    expect(clientUpdate?.values.email).toBeUndefined();
    expect(clientUpdate?.values.preferredLanguage).toBe("it");
  });
});
