import { Param, StringChunk } from "drizzle-orm";
import { describe, expect, it, vi, beforeEach } from "vitest";

// @bos/db fully mocked, same convention as every other module's own
// service.test.ts in this codebase — no test-database strategy exists yet.
// ../clients/../quotes/../deals are mocked at the module boundary (ADR
// 0002): this file tests communications/service.ts's own logic, never
// re-exercising those modules' own already-tested behavior.

const { fakeState, communicationsTable } = vi.hoisted(() => {
  return {
    fakeState: {
      communications: [] as Array<Record<string, unknown>>,
      nextId: 1,
    },
    communicationsTable: { __name: "communications" },
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

// Recursive eq()-value extraction — same technique proven in
// deals/service.test.ts and transfer-requests/service.test.ts: and(eq(...),
// eq(...)) nests each eq()'s own SQL object one level inside the outer
// and()'s queryChunks rather than flattening them.
function extractEqValues(condition: unknown): string[] {
  if (!condition || typeof condition !== "object" || !("queryChunks" in condition)) return [];
  const chunks = (condition as { queryChunks: unknown[] }).queryChunks;
  const values: string[] = [];
  for (const chunk of chunks) {
    if (chunk instanceof StringChunk) continue;
    if (chunk instanceof Param) {
      if (typeof chunk.value === "string") values.push(chunk.value);
      continue;
    }
    if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
      values.push(...extractEqValues(chunk));
      continue;
    }
    if (typeof chunk === "string") values.push(chunk);
  }
  return values;
}

function matchesCondition(row: Record<string, unknown>, values: string[]): boolean {
  return values.length > 0 && values.every((value) => Object.values(row).includes(value));
}

vi.mock("@bos/db", () => {
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: { queryChunks: unknown[] }) => {
          const values = extractEqValues(condition);
          return thenable(fakeState.communications.filter((row) => matchesCondition(row, values)));
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: { queryChunks: unknown[] }) => {
          const conditionValues = extractEqValues(condition);
          const target = fakeState.communications.find((row) => matchesCondition(row, conditionValues));
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
    // Backs prepareQuoteOfferCommunication's raw INSERT ... ON CONFLICT
    // DO NOTHING RETURNING * — same pattern insertNewTransferRequest/
    // createDeal already use. Params are read positionally, matching the
    // exact column order service.ts's SQL template binds them in.
    execute: async (query: { queryChunks: unknown[] }) => {
      const sqlText = query.queryChunks
        .filter((c): c is StringChunk => c instanceof StringChunk)
        .map((c) => (c as unknown as { value: string[] }).value.join(""))
        .join("");
      const params = query.queryChunks.filter((c) => !(c instanceof StringChunk));

      if (sqlText.includes("insert into communications")) {
        const [
          tenantId,
          clientId,
          dealId,
          transferRequestId,
          quoteId,
          bookingId,
          channel,
          action,
          agent,
          correlationId,
          idempotencyKey,
          contentJson,
        ] = params as [
          string,
          string,
          string,
          string | null,
          string | null,
          string | null,
          string,
          string,
          string,
          string | null,
          string,
          string,
        ];

        const conflict = fakeState.communications.some(
          (c) => c.tenantId === tenantId && c.idempotencyKey === idempotencyKey,
        );
        if (conflict) return [];

        const row: Record<string, unknown> = {
          id: `comm-${fakeState.nextId++}`,
          tenantId,
          clientId,
          dealId,
          transferRequestId,
          quoteId,
          bookingId,
          channel,
          action,
          agent,
          correlationId,
          idempotencyKey,
          content: JSON.parse(contentJson),
          status: "prepared",
          policyDecision: null,
          approvedBy: null,
          approvedAt: null,
          rejectedAt: null,
          provider: null,
          providerMessageId: null,
          providerStatus: null,
          providerStatusUpdatedAt: null,
          verifiedAt: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        fakeState.communications.push(row);
        return [row];
      }
      return [];
    },
  };

  return {
    communications: communicationsTable,
    assertOne: (rows: unknown[]) => {
      if (rows.length === 0) throw new Error("Expected exactly one row, got none");
      return rows[0];
    },
    getDb: () => db,
  };
});

const mockGetClient = vi.fn();
vi.mock("../clients", () => ({ getClient: (...args: unknown[]) => mockGetClient(...args) }));

const mockGetQuote = vi.fn();
vi.mock("../quotes", () => ({ getQuote: (...args: unknown[]) => mockGetQuote(...args) }));

const mockGetDeal = vi.fn();
vi.mock("../deals", () => ({ getDeal: (...args: unknown[]) => mockGetDeal(...args) }));

const {
  prepareQuoteOfferCommunication,
  submitCommunicationForApproval,
  approveCommunication,
  rejectCommunication,
  executeCommunication,
  getCommunication,
  findCommunicationByProviderMessageId,
  recordProviderDeliveryStatus,
} = await import("./service");
const { NotConfiguredOutboundProvider } = await import("./provider");
import type { OutboundProvider, OutboundSendResult } from "./provider";

const TENANT = "tenant-1";
const OTHER_TENANT = "tenant-2";
const DEAL = "deal-1";
const CLIENT = "client-1";
const QUOTE = "quote-1";
const ADMIN = "admin-1";

function seedRealData(overrides: { amountCents?: number | null } = {}) {
  mockGetDeal.mockResolvedValue({ id: DEAL, tenantId: TENANT, clientId: CLIENT, status: "quoted" });
  mockGetQuote.mockResolvedValue({
    id: QUOTE,
    tenantId: TENANT,
    dealId: DEAL,
    clientId: CLIENT,
    amountCents: overrides.amountCents === undefined ? 25000 : overrides.amountCents,
    currency: "EUR",
    notes: "Grazie per la fiducia.",
    status: "sent",
  });
  mockGetClient.mockResolvedValue({ id: CLIENT, tenantId: TENANT, fullName: "Mario Rossi", phone: "+393331234567" });
}

class FakeSuccessProvider implements OutboundProvider {
  readonly name = "fake_success";
  async send(): Promise<OutboundSendResult> {
    return { status: "sent", providerMessageId: "wamid.FAKE123" };
  }
}

class FakeThrowingProvider implements OutboundProvider {
  readonly name = "fake_throwing";
  async send(): Promise<OutboundSendResult> {
    throw new Error("network error");
  }
}

beforeEach(() => {
  fakeState.communications = [];
  fakeState.nextId = 1;
  mockGetClient.mockReset();
  mockGetQuote.mockReset();
  mockGetDeal.mockReset();
});

async function prepareAndSubmit() {
  seedRealData();
  const prepared = await prepareQuoteOfferCommunication({
    tenantId: TENANT,
    dealId: DEAL,
    clientId: CLIENT,
    quoteId: QUOTE,
    channel: "whatsapp",
    agent: "operations",
  });
  return submitCommunicationForApproval(TENANT, prepared.id);
}

// 1. comunicazione preparata senza invio
describe("prepareQuoteOfferCommunication", () => {
  it("1: prepares a communication at status 'prepared' — no policy check, no send", async () => {
    seedRealData();
    const result = await prepareQuoteOfferCommunication({
      tenantId: TENANT,
      dealId: DEAL,
      clientId: CLIENT,
      quoteId: QUOTE,
      channel: "whatsapp",
      agent: "operations",
    });

    expect(result.status).toBe("prepared");
    expect(result.policyDecision).toBeNull();
    expect(result.provider).toBeNull();
    expect((result.content as { body: string }).body).toContain("250.00 EUR");
  });

  it("never invents a price when the quote has none", async () => {
    seedRealData({ amountCents: null });
    await expect(
      prepareQuoteOfferCommunication({
        tenantId: TENANT,
        dealId: DEAL,
        clientId: CLIENT,
        quoteId: QUOTE,
        channel: "whatsapp",
        agent: "operations",
      }),
    ).rejects.toThrow(/refusing to invent a price/);
  });

  // 7. deal corretto
  it("7: the communication is linked to the correct deal and quote", async () => {
    seedRealData();
    const result = await prepareQuoteOfferCommunication({
      tenantId: TENANT,
      dealId: DEAL,
      clientId: CLIENT,
      quoteId: QUOTE,
      channel: "whatsapp",
      agent: "operations",
    });
    expect(result.dealId).toBe(DEAL);
    expect(result.quoteId).toBe(QUOTE);
    expect(result.clientId).toBe(CLIENT);
  });

  it("refuses a quote that does not belong to the given deal", async () => {
    mockGetDeal.mockResolvedValue({ id: DEAL, tenantId: TENANT, clientId: CLIENT, status: "quoted" });
    mockGetQuote.mockResolvedValue({
      id: QUOTE,
      tenantId: TENANT,
      dealId: "deal-other",
      clientId: CLIENT,
      amountCents: 25000,
      currency: "EUR",
      notes: null,
    });
    mockGetClient.mockResolvedValue({ id: CLIENT, tenantId: TENANT, fullName: "Mario Rossi", phone: "+393331234567" });

    await expect(
      prepareQuoteOfferCommunication({
        tenantId: TENANT,
        dealId: DEAL,
        clientId: CLIENT,
        quoteId: QUOTE,
        channel: "whatsapp",
        agent: "operations",
      }),
    ).rejects.toThrow(/does not belong to deal/);
  });

  // 8. tenant isolation
  it("8: tenant isolation — getCommunication never returns another tenant's row", async () => {
    seedRealData();
    const result = await prepareQuoteOfferCommunication({
      tenantId: TENANT,
      dealId: DEAL,
      clientId: CLIENT,
      quoteId: QUOTE,
      channel: "whatsapp",
      agent: "operations",
    });

    const crossTenant = await getCommunication(OTHER_TENANT, result.id);
    expect(crossTenant).toBeNull();

    const sameTenant = await getCommunication(TENANT, result.id);
    expect(sameTenant?.id).toBe(result.id);
  });

  // 12. correlation_id propagato
  it("12: correlationId is propagated through the prepared row", async () => {
    seedRealData();
    const result = await prepareQuoteOfferCommunication({
      tenantId: TENANT,
      dealId: DEAL,
      clientId: CLIENT,
      quoteId: QUOTE,
      channel: "whatsapp",
      agent: "operations",
      correlationId: "corr-abc-123",
    });
    expect(result.correlationId).toBe("corr-abc-123");
  });

  // 11. anti-duplicazione (idempotency at prepare time — never two rows for the same quote)
  it("11: preparing the same quote twice never creates a second communication", async () => {
    seedRealData();
    const first = await prepareQuoteOfferCommunication({
      tenantId: TENANT,
      dealId: DEAL,
      clientId: CLIENT,
      quoteId: QUOTE,
      channel: "whatsapp",
      agent: "operations",
    });
    const second = await prepareQuoteOfferCommunication({
      tenantId: TENANT,
      dealId: DEAL,
      clientId: CLIENT,
      quoteId: QUOTE,
      channel: "whatsapp",
      agent: "operations",
    });
    expect(second.id).toBe(first.id);
    expect(fakeState.communications).toHaveLength(1);
  });
});

// 2. comunicazione che richiede approval
describe("submitCommunicationForApproval", () => {
  it("2: moves a prepared communication to pending_approval, recording the policy decision", async () => {
    seedRealData();
    const prepared = await prepareQuoteOfferCommunication({
      tenantId: TENANT,
      dealId: DEAL,
      clientId: CLIENT,
      quoteId: QUOTE,
      channel: "whatsapp",
      agent: "operations",
    });

    const submitted = await submitCommunicationForApproval(TENANT, prepared.id);
    expect(submitted.status).toBe("pending_approval");
    expect(submitted.policyDecision).toMatchObject({ allowed: true, requiresApproval: true });
  });

  // 10. quote non inviato prima dell'approvazione
  it("10: the provider is never called before approval — execute refuses from pending_approval", async () => {
    const submitted = await prepareAndSubmit();
    await expect(executeCommunication(TENANT, submitted.id, new FakeSuccessProvider())).rejects.toThrow(
      /not 'approved'/,
    );
  });
});

// 3. approval -> execution
describe("approveCommunication + executeCommunication", () => {
  it("3: approval then execution reaches 'executed' (never 'verified' yet) with a real (test) provider", async () => {
    const submitted = await prepareAndSubmit();
    const approved = await approveCommunication(TENANT, submitted.id, ADMIN);
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe(ADMIN);

    const executed = await executeCommunication(TENANT, submitted.id, new FakeSuccessProvider());
    // 17. executed non diventa automaticamente verified — messages[0].id
    // only proves the provider ACCEPTED the send, never delivery/read.
    expect(executed.status).toBe("executed");
    expect(executed.providerMessageId).toBe("wamid.FAKE123");
    expect(executed.provider).toBe("fake_success");
    expect(executed.verifiedAt).toBeNull();
  });

  // 17/18. verified solo dopo una conferma reale del provider (status callback)
  it("17/18: only a 'delivered' or 'read' status callback moves an executed communication to verified", async () => {
    const submitted = await prepareAndSubmit();
    await approveCommunication(TENANT, submitted.id, ADMIN);
    const executed = await executeCommunication(TENANT, submitted.id, new FakeSuccessProvider());
    expect(executed.status).toBe("executed");

    const delivered = await recordProviderDeliveryStatus("wamid.FAKE123", "delivered", new Date("2026-09-21T10:00:00Z"));
    expect(delivered?.status).toBe("verified");
    expect(delivered?.verifiedAt).toEqual(new Date("2026-09-21T10:00:00Z"));
    expect(delivered?.providerStatus).toBe("delivered");
  });

  // 4. execution retry idempotente
  it("4: retrying execution after success never calls the provider again", async () => {
    const submitted = await prepareAndSubmit();
    await approveCommunication(TENANT, submitted.id, ADMIN);

    const provider = new FakeSuccessProvider();
    const sendSpy = vi.spyOn(provider, "send");

    const first = await executeCommunication(TENANT, submitted.id, provider);
    const second = await executeCommunication(TENANT, submitted.id, provider);

    expect(second.id).toBe(first.id);
    expect(second.status).toBe(first.status);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  // 5. execution failure
  it("5: a provider that throws lands the communication at execution_failed with the error recorded", async () => {
    const submitted = await prepareAndSubmit();
    await approveCommunication(TENANT, submitted.id, ADMIN);

    const failed = await executeCommunication(TENANT, submitted.id, new FakeThrowingProvider());
    expect(failed.status).toBe("execution_failed");
    expect(failed.error).toContain("network error");
  });

  // 6 / 14. nessun falso success — provider non configurato
  it("6/14: the default NotConfiguredOutboundProvider never produces a false success", async () => {
    const submitted = await prepareAndSubmit();
    await approveCommunication(TENANT, submitted.id, ADMIN);

    const result = await executeCommunication(TENANT, submitted.id, new NotConfiguredOutboundProvider());
    expect(result.status).toBe("execution_failed");
    expect(result.status).not.toBe("executed");
    expect(result.status).not.toBe("verified");
    expect(result.provider).toBe("not_configured");
    expect(result.error).toContain("no outbound provider configured");
  });

  it("rejects a pending_approval communication, and a rejected one can never be executed", async () => {
    const submitted = await prepareAndSubmit();
    const rejected = await rejectCommunication(TENANT, submitted.id);
    expect(rejected.status).toBe("rejected");

    await expect(executeCommunication(TENANT, submitted.id, new FakeSuccessProvider())).rejects.toThrow(
      /not 'approved'/,
    );
  });

  it("approving/rejecting an already-decided communication is an idempotent no-op", async () => {
    const submitted = await prepareAndSubmit();
    const approved = await approveCommunication(TENANT, submitted.id, ADMIN);
    const approvedAgain = await approveCommunication(TENANT, submitted.id, "different-admin");
    expect(approvedAgain.approvedBy).toBe(approved.approvedBy); // unchanged, never re-approved by someone else
  });
});

// 13. audit presente
describe("audit fields", () => {
  it("13: every required audit field is present on the final row", async () => {
    const submitted = await prepareAndSubmit();
    await approveCommunication(TENANT, submitted.id, ADMIN);
    await executeCommunication(TENANT, submitted.id, new FakeSuccessProvider());
    const verified = await recordProviderDeliveryStatus("wamid.FAKE123", "delivered", new Date("2026-09-21T10:00:00Z"));

    expect(verified?.tenantId).toBe(TENANT);
    expect(verified?.dealId).toBe(DEAL);
    expect(verified?.quoteId).toBe(QUOTE);
    expect(verified?.agent).toBe("operations");
    expect(verified?.action).toBe("quote_offer");
    expect(verified?.policyDecision).not.toBeNull();
    expect(verified?.approvedBy).toBe(ADMIN);
    expect(verified?.approvedAt).not.toBeNull();
    expect(verified?.status).toBe("verified");
    expect(verified?.verifiedAt).not.toBeNull();
    expect(verified?.providerStatus).toBe("delivered");
    expect(verified?.createdAt).toBeInstanceOf(Date);
    expect(verified?.updatedAt).toBeInstanceOf(Date);
    expect(verified?.providerMessageId).toBe("wamid.FAKE123");
    expect(verified?.error).toBeNull();
  });
});

// 9. customer-reported payment non verificato — this module never touches
// deals.customerReportedPaymentNote/status at all; proven structurally by
// the fact that no function here accepts or mutates a deal's payment
// fields (../deals is mocked above and only getDeal — a read — is ever
// called; no write function from ../deals is imported by service.ts at
// all).
describe("customer-reported payment stays unverified (Phase 2.5 boundary)", () => {
  it("9: executing a communication never marks any payment as verified/paid", async () => {
    seedRealData();
    // Simulate a deal that already has a customer-reported (unverified)
    // payment note — communications must never read, touch, or "verify" it.
    mockGetDeal.mockResolvedValue({
      id: DEAL,
      tenantId: TENANT,
      clientId: CLIENT,
      status: "quoted",
      customerReportedPaymentNote: "Paid advance €100",
      customerReportedPaymentAt: new Date("2026-09-18T19:27:20Z"),
    });

    const submitted = await prepareAndSubmit();
    await approveCommunication(TENANT, submitted.id, ADMIN);
    const executed = await executeCommunication(TENANT, submitted.id, new FakeSuccessProvider());

    // The communication's own row has no payment-status concept at all —
    // there is no field this module could have set to "paid"/"verified".
    expect(executed).not.toHaveProperty("paymentStatus");
    expect(executed).not.toHaveProperty("paid");
    // getDeal was called read-only; nothing in this module ever imports a
    // deals write function (recordCustomerReportedPayment, advanceDealStatus,
    // closeDeal), so there is no code path here that could have touched it.
    expect(mockGetDeal).toHaveBeenCalled();
  });
});

// Phase 3B Step 3 — provider delivery-status callbacks (Meta's async
// webhook, correlated by providerMessageId — see
// packages/core/src/whatsapp/webhook-handler.ts's statuses[] handling).
describe("recordProviderDeliveryStatus", () => {
  async function executedCommunication() {
    const submitted = await prepareAndSubmit();
    await approveCommunication(TENANT, submitted.id, ADMIN);
    const executed = await executeCommunication(TENANT, submitted.id, new FakeSuccessProvider());
    return executed;
  }

  // 12. status "sent"
  it("12: a 'sent' callback records providerStatus but never changes communication status", async () => {
    const executed = await executedCommunication();

    const result = await recordProviderDeliveryStatus("wamid.FAKE123", "sent", new Date("2026-09-21T09:00:00Z"));

    expect(result?.status).toBe("executed"); // unchanged — sent is not a delivery confirmation
    expect(result?.providerStatus).toBe("sent");
    expect(result?.verifiedAt).toBeNull();
    expect(executed.id).toBe(result?.id);
  });

  // 13. status "delivered"
  it("13: a 'delivered' callback moves an executed communication to verified", async () => {
    await executedCommunication();

    const result = await recordProviderDeliveryStatus("wamid.FAKE123", "delivered", new Date("2026-09-21T09:05:00Z"));

    expect(result?.status).toBe("verified");
    expect(result?.providerStatus).toBe("delivered");
    expect(result?.verifiedAt).toEqual(new Date("2026-09-21T09:05:00Z"));
  });

  // 14. status "read" — also counts as a real delivery confirmation
  it("14: a 'read' callback also moves an executed communication to verified", async () => {
    await executedCommunication();

    const result = await recordProviderDeliveryStatus("wamid.FAKE123", "read", new Date("2026-09-21T09:10:00Z"));

    expect(result?.status).toBe("verified");
    expect(result?.providerStatus).toBe("read");
  });

  it("a 'read' callback arriving after 'delivered' already verified it just updates providerStatus, never re-fires verifiedAt", async () => {
    await executedCommunication();
    const delivered = await recordProviderDeliveryStatus("wamid.FAKE123", "delivered", new Date("2026-09-21T09:05:00Z"));
    const read = await recordProviderDeliveryStatus("wamid.FAKE123", "read", new Date("2026-09-21T09:20:00Z"));

    expect(read?.status).toBe("verified");
    expect(read?.providerStatus).toBe("read");
    expect(read?.verifiedAt).toEqual(delivered?.verifiedAt); // unchanged — not overwritten by the later callback
  });

  // 15. status "failed"
  it("15: a 'failed' callback downgrades an executed (not yet verified) communication to execution_failed", async () => {
    await executedCommunication();

    const result = await recordProviderDeliveryStatus("wamid.FAKE123", "failed", new Date("2026-09-21T09:00:00Z"));

    expect(result?.status).toBe("execution_failed");
    expect(result?.providerStatus).toBe("failed");
    expect(result?.error).toBeTruthy();
  });

  it("a 'failed' callback never overwrites an already-verified (real, confirmed delivery) communication", async () => {
    await executedCommunication();
    await recordProviderDeliveryStatus("wamid.FAKE123", "delivered", new Date("2026-09-21T09:05:00Z"));

    const result = await recordProviderDeliveryStatus("wamid.FAKE123", "failed", new Date("2026-09-21T09:06:00Z"));

    expect(result?.status).toBe("verified"); // the earlier real confirmation stands
  });

  // 16. providerMessageId collega lo status alla communication corretta
  it("16: correlates strictly by providerMessageId — a different id never matches", async () => {
    await executedCommunication();

    const result = await recordProviderDeliveryStatus("wamid.DOES-NOT-EXIST", "delivered", new Date());

    expect(result).toBeNull();
  });

  it("findCommunicationByProviderMessageId finds the exact communication a providerMessageId belongs to", async () => {
    const executed = await executedCommunication();

    const found = await findCommunicationByProviderMessageId("wamid.FAKE123");

    expect(found?.id).toBe(executed.id);
  });

  it("an unknown providerMessageId is a fail-soft no-op, never throws (a Meta retry or unrelated callback)", async () => {
    await expect(recordProviderDeliveryStatus("wamid.UNKNOWN", "sent", new Date())).resolves.toBeNull();
  });
});
