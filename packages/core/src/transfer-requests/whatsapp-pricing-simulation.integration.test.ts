import { Param, StringChunk } from "drizzle-orm";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Controlled end-to-end simulation ─────────────────────────────────────
// Exercises the REAL production functions across four modules —
// whatsapp.processInboundMessage, transfer-requests.processTransferRequestForMessageAndPrice
// (the automatic trigger: processTransferRequestForMessage, clients.getClient,
// pricing.determineCustomerType, and transfer-requests.runPricingForTransferRequest,
// all composed — not reimplemented here), and pricing.calculatePrice. Only
// the two I/O boundaries are faked: @bos/db (no real database exists for
// this repo yet — see docs/PRODUCTION_ROADMAP.md Milestone 3) and the
// Claude-based parser (replaced with a fixed, clearly-marked TEST
// extraction so the simulation is deterministic and doesn't depend on live
// LLM output or an ANTHROPIC_API_KEY).
//
// Goal: prove the module CONNECTION works end-to-end with data that would
// exercise the full happy path (a fixed airport fare, so no Google Maps
// integration is needed — Malpensa -> Sondrio never requires distanceKm).
// This is not a substitute for the individual unit test suites already
// covering each module's own logic in isolation.
//
// NOT wired into the real webhook, Meta, or Supabase production — this
// file is a permanent, repository-committed integration test (vitest),
// not a throwaway script, per the explicitly stated preference.

const {
  fakeState,
  tenantsTable,
  clientsTable,
  whatsappMessagesTable,
  transferRequestsTable,
} = vi.hoisted(() => {
  return {
    fakeState: {
      tenant: { id: "tenant-test-1", slug: "bonolini-transfer" },
      clients: [] as Array<Record<string, unknown>>,
      whatsappMessages: [] as Array<Record<string, unknown>>,
      transferRequests: [] as Array<Record<string, unknown>>,
      nextClientId: 1,
      nextRequestId: 1,
    },
    tenantsTable: { __name: "tenants" },
    clientsTable: { __name: "clients" },
    whatsappMessagesTable: { __name: "whatsappMessages" },
    transferRequestsTable: { __name: "transferRequests" },
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

function sourceFor(table: unknown): Array<Record<string, unknown>> {
  if (table === clientsTable) return fakeState.clients;
  if (table === whatsappMessagesTable) return fakeState.whatsappMessages;
  if (table === transferRequestsTable) return fakeState.transferRequests;
  return [];
}

// Same extraction technique proven in whatsapp/service.test.ts and
// transfer-requests/service.test.ts — eq(column, value) against these
// mocked placeholder tables (no real Column object) embeds the bound value
// as a raw chunk rather than a Param instance; handling both shapes keeps
// this correct either way.
function extractEqValue(condition: { queryChunks: unknown[] }): string | undefined {
  const candidate = condition.queryChunks.find(
    (c) => c !== undefined && c !== null && !(c instanceof StringChunk),
  );
  if (candidate instanceof Param) return candidate.value as string;
  return candidate as string | undefined;
}

function normalizePhoneForMock(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

vi.mock("@bos/db", () => {
  const db = {
    select: (cols?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (condition: { queryChunks: unknown[] }) => {
          if (table === tenantsTable) return thenable([fakeState.tenant]);

          // The one case that needs real filtering: transfer-requests'
          // idempotency lookup by whatsapp_messages.id (cols is present
          // only for that specific call).
          if (table === whatsappMessagesTable && cols) {
            const targetId = extractEqValue(condition);
            const filtered = fakeState.whatsappMessages.filter((r) => r.id === targetId);
            return thenable(filtered.map((row) => ({ transferRequestId: row.transferRequestId })));
          }

          return thenable(sourceFor(table));
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== whatsappMessagesTable) return [];
            const exists = fakeState.whatsappMessages.some(
              (m) => m.tenantId === vals.tenantId && m.whatsappMessageId === vals.whatsappMessageId,
            );
            if (exists) return [];
            const row = { id: `msg-test-${fakeState.whatsappMessages.length + 1}`, clientId: null, parsed: null, transferRequestId: null, ...vals };
            fakeState.whatsappMessages.push(row);
            return [row];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: { queryChunks: unknown[] }) => {
          const source = sourceFor(table);
          const targetId = extractEqValue(condition);
          const target = source.find((r) => r.id === targetId);
          if (target) Object.assign(target, values);
          const result = target ? [target] : [];
          const promise = Promise.resolve(result);
          return {
            returning: async () => result,
            then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => promise.then(resolve, reject),
            catch: (reject: (e: unknown) => void) => promise.catch(reject),
          };
        },
      }),
    }),
    // Backs both raw-SQL upserts this simulation touches: clients
    // (whatsapp module's findOrCreateClientByPhone) and transfer_requests
    // (transfer-requests module's insertNewTransferRequest). Distinguished
    // by the literal SQL text in the template's StringChunks — each
    // template's text is stable and distinct.
    execute: async (query: { queryChunks: unknown[] }) => {
      // StringChunk.value is an array of literal text segments, not
      // directly stringifiable — verified against the installed
      // drizzle-orm version rather than assumed (same discipline as
      // elsewhere in this codebase after the earlier Date-serialization
      // incident taught it not to guess at internal shapes).
      const sqlText = query.queryChunks
        .filter((c): c is StringChunk => c instanceof StringChunk)
        .map((c) => (c as unknown as { value: string[] }).value.join(""))
        .join("");
      const params = query.queryChunks.filter((c) => !(c instanceof StringChunk));

      if (sqlText.includes("insert into clients")) {
        const [tenantId, fullName, normalizedPhone, receivedAt] = params as [string, string, string, Date];
        const conflicting = fakeState.clients.find(
          (c) => c.tenantId === tenantId && !c.deletedAt && normalizePhoneForMock(c.phone as string) === normalizedPhone,
        );
        if (conflicting) return [];
        const row = {
          id: `client-test-${fakeState.nextClientId++}`,
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
        return [row];
      }

      if (sqlText.includes("insert into transfer_requests")) {
        const [
          tenantId, clientId, status, intent, pickup, destination,
          requestedDate, requestedTime, passengers, luggage,
          flightNumber, trainNumber, hotel, language,
        ] = params as [string, string, string, ...unknown[]];
        const OPEN_STATUSES = ["collecting_info", "ready_for_pricing"];
        const conflict = fakeState.transferRequests.some(
          (r) => r.tenantId === tenantId && r.clientId === clientId && OPEN_STATUSES.includes(r.status as string),
        );
        if (conflict) return [];
        const row: Record<string, unknown> = {
          id: `request-test-${fakeState.nextRequestId++}`,
          tenantId, clientId, status, intent, pickup, destination,
          requestedDate, requestedTime, passengers, luggage,
          flightNumber, trainNumber, hotel, language,
          missingInformation: null,
          pricingStatus: "not_priced",
          calculatedAmountCents: null,
          currency: "EUR",
          pricingBreakdown: null,
          quoteId: null,
          adminApprovedAt: null,
          adminApprovedBy: null,
          cancelledReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        fakeState.transferRequests.push(row);
        return [row];
      }

      return [];
    },
  };

  return {
    tenants: tenantsTable,
    clients: clientsTable,
    whatsappMessages: whatsappMessagesTable,
    transferRequests: transferRequestsTable,
    assertOne: (rows: unknown[]) => rows[0],
    getDb: () => db,
  };
});

// Replaces Claude extraction with a fixed, clearly-marked TEST payload —
// deterministic, no live LLM call, no ANTHROPIC_API_KEY dependency. This
// simulation verifies the module CONNECTION, not parser accuracy (already
// covered separately in whatsapp/parser.test.ts). Configured per-test via
// mockResolvedValueOnce below, since the two scenarios need different
// extracted data.
const mockParseWhatsappMessage = vi.fn();
vi.mock("../whatsapp/parser", () => ({
  parseWhatsappMessage: (...args: unknown[]) => mockParseWhatsappMessage(...args),
}));

const { processInboundMessage } = await import("../whatsapp/service");
const { processTransferRequestForMessageAndPrice, getTransferRequest } = await import("./service");
const { determineCustomerType } = await import("../pricing");

beforeEach(() => {
  fakeState.clients = [];
  fakeState.whatsappMessages = [];
  fakeState.transferRequests = [];
  fakeState.nextClientId = 1;
  fakeState.nextRequestId = 1;
});

describe("WhatsApp -> Transfer Request -> Pricing — controlled simulation", () => {
  // Clearly marked TEST data — never a real WhatsApp number, never sent to Meta.
  const TEST_PHONE = "+999000000001"; // does not start with "39" -> foreign, by construction

  it("[literal requested scenario] Malpensa (pickup) -> Sondrio (destination): a real, honest discovery — this resolves to manual_required, not fixed", async () => {
    // IMPORTANT FINDING, not a bug in this simulation: the fixed-fare
    // table (recovered verbatim from CChiefGrowthAI's pricing_engine.py)
    // matches only on DESTINATION, exactly like the original
    // _trova_tariffa_fissa(). A "ritorno" trip (pickup = the airport,
    // destination = Sondrio) never matches it — in the original
    // CChiefGrowthAI, that case fell through to the km formula instead,
    // priced using its live Google Maps integration. Our pricing engine
    // has no distance source yet, so the same case here is honestly
    // manual_required. This is exactly the scenario literally requested,
    // kept as-is and asserted against its real outcome — not adjusted to
    // produce a "fixed" result it doesn't actually produce.
    mockParseWhatsappMessage.mockResolvedValueOnce({
      pickup: "Malpensa",
      destination: "Sondrio",
      date: "2026-09-20",
      time: "10:00",
      passengers: 4,
      flight: "FR1234",
      language: "en",
      intent: "transfer_request",
    });

    const inbound = await processInboundMessage({
      waMessageId: "wamid.TEST-SIMULATION-0001",
      fromPhone: TEST_PHONE,
      type: "text",
      rawText: "[TEST SIMULATION] transfer Malpensa -> Sondrio, 4 persone, 20 settembre alle 10:00, volo FR1234",
      profileName: null,
      receivedAt: new Date("2026-08-20T09:00:00Z"),
    });
    expect(inbound.status).toBe("processed");
    expect(inbound.clientId).not.toBeNull();

    // Assertion 1: client resolved/created
    const client = fakeState.clients.find((c) => c.id === inbound.clientId);
    expect(client).toBeDefined();
    expect(client!.phone).toBe(normalizePhoneForMock(TEST_PHONE));

    // Bridge to transfer-requests via the automatic trigger under test:
    // processTransferRequestForMessageAndPrice runs
    // processTransferRequestForMessage AND — since this message completes
    // the request in one shot — resolves customerType for real (reading the
    // client's phone through clients.getClient(), then
    // pricing.determineCustomerType(), never re-implemented here) and calls
    // runPricingForTransferRequest() automatically. Direct field subset of
    // the parsed message, not a transformation.
    const parsed = inbound.parsed!;
    const priced = await processTransferRequestForMessageAndPrice({
      tenantId: fakeState.tenant.id,
      clientId: inbound.clientId!,
      whatsappMessageId: inbound.messageId,
      extracted: {
        intent: parsed.intent,
        pickup: parsed.pickup,
        destination: parsed.destination,
        date: parsed.date,
        time: parsed.time,
        passengers: parsed.passengers,
        flight: parsed.flight,
        language: parsed.language,
      },
    });

    // Assertion 2-6: the request itself, built automatically
    expect(priced.pickup).toBe("Malpensa");
    expect(priced.destination).toBe("Sondrio");
    expect(priced.passengers).toBe(4);

    // customerType was resolved automatically from the client's phone by
    // the trigger, not passed in by this test — cross-checked against the
    // same pure function used for the assertion, independently confirming
    // the resolution is correct rather than merely present.
    expect(determineCustomerType(TEST_PHONE)).toBe("foreign");
    expect((priced.pricingBreakdown as Record<string, unknown>).customerType).toBe("foreign");

    // The real, honest outcome for this exact literal scenario:
    expect(priced.pricingStatus).toBe("manual_required");
    expect(priced.calculatedAmountCents).toBeNull();
    expect(priced.pricingBreakdown).toMatchObject({ manualRequiredReason: "distance_not_provided" });
    // Status correctly does NOT advance — nothing is ready to send an admin.
    expect(priced.status).toBe("ready_for_pricing");
    // All transfer-request data is retained regardless.
    expect(priced.pickup).toBe("Malpensa");
    expect(priced.destination).toBe("Sondrio");
    expect(priced.passengers).toBe(4);
    // hospitalWaiting still present and correctly inert (Sondrio isn't a hospital keyword).
    expect((priced.pricingBreakdown as Record<string, unknown>).hospitalWaiting).toMatchObject({ applies: false });
  });

  it("[andata direction, to demonstrate a real fixed price end-to-end] Sondrio -> Malpensa produces pricingStatus=fixed, 250 EUR, pending_admin_approval", async () => {
    mockParseWhatsappMessage.mockResolvedValueOnce({
      pickup: "Sondrio",
      destination: "Malpensa",
      date: "2026-09-20",
      time: "10:00",
      passengers: 4,
      language: "en",
      intent: "transfer_request",
    });

    const inbound = await processInboundMessage({
      waMessageId: "wamid.TEST-SIMULATION-0002",
      fromPhone: TEST_PHONE,
      type: "text",
      rawText: "[TEST SIMULATION] transfer Sondrio -> Malpensa, 4 persone, 20 settembre alle 10:00",
      profileName: null,
      receivedAt: new Date("2026-08-20T09:00:00Z"),
    });
    expect(inbound.status).toBe("processed");

    const parsed = inbound.parsed!;
    const priced = await processTransferRequestForMessageAndPrice({
      tenantId: fakeState.tenant.id,
      clientId: inbound.clientId!,
      whatsappMessageId: inbound.messageId,
      extracted: {
        intent: parsed.intent,
        pickup: parsed.pickup,
        destination: parsed.destination,
        date: parsed.date,
        time: parsed.time,
        passengers: parsed.passengers,
        language: parsed.language,
      },
    });

    // customerType resolved automatically by the trigger from the client's
    // phone, not supplied by this test.
    expect(determineCustomerType(TEST_PHONE)).toBe("foreign");
    expect((priced.pricingBreakdown as Record<string, unknown>).customerType).toBe("foreign");

    // Assertion 7-11
    expect(priced.pricingStatus).toBe("fixed");
    expect((priced.pricingBreakdown as Record<string, unknown>).matchedRule).toBe("fixed_airport_malpensa");
    expect(priced.currency).toBe("EUR");
    expect(priced.calculatedAmountCents).toBe(25000); // Malpensa, foreign, 4 passengers

    // Assertion 12: hospitalWaiting present but inert, never touches the price.
    const hospitalWaiting = (priced.pricingBreakdown as Record<string, unknown>).hospitalWaiting as Record<string, unknown>;
    expect(hospitalWaiting.applies).toBe(false);
    expect(priced.calculatedAmountCents).toBe(25000);

    // Assertion 13: final status
    expect(priced.status).toBe("pending_admin_approval");

    // Re-read independently, proving persistence actually happened.
    const reread = await getTransferRequest(fakeState.tenant.id, priced.id);
    expect(reread?.status).toBe("pending_admin_approval");
    expect(reread?.calculatedAmountCents).toBe(25000);
  });
});
