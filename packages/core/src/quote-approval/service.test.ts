import { describe, expect, it, vi, beforeEach } from "vitest";
import type { QuoteApprovalRequest, TransferRequest } from "@bos/db";

// repository.ts is replaced by an in-memory fake with the same conditional
// semantics (a transition only succeeds from the listed statuses), so these
// tests exercise double taps and stale buttons for real. Other modules are
// mocked at their public boundary (ADR 0002).

const { state } = vi.hoisted(() => ({
  state: {
    rows: [] as QuoteApprovalRequest[],
    founderMessages: new Set<string>(),
    nextId: 1,
    transferRequests: new Map<string, TransferRequest>(),
    communications: new Map<string, { id: string; status: string; error: string | null; content: unknown }>(),
    founderOutbox: [] as Array<{ parts: string[]; buttons?: Array<{ id: string; title: string }> }>,
    customerSends: 0,
    adminProfile: true,
    customerPhone: "+393331234567",
    sendResult: "executed" as "executed" | "execution_failed",
    bookings: [] as Array<Record<string, unknown>>,
    confirmations: new Map<string, { id: string; status: string; error: string | null; content: unknown }>(),
    confirmationSendResult: "executed" as "executed" | "execution_failed",
  },
}));

// A booking per approved transfer_request, created by the accept/modify
// mocks below exactly like transfer-requests does: pending_deposit with the
// deposit it was given.
function createBookingFor(transferRequestId: string, finalAmountCents: number, depositAmountCents: number) {
  if (state.bookings.some((b) => b.transferRequestId === transferRequestId)) return;
  state.bookings.push({
    id: `00000000-0000-4000-9000-${String(state.bookings.length + 1).padStart(12, "0")}`,
    tenantId: "tenant-1",
    clientId: "client-1",
    dealId: "deal-1",
    transferRequestId,
    status: "pending_deposit",
    finalAmountCents,
    depositAmountCents,
    depositPaidAt: null,
    currency: "EUR",
  });
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

vi.mock("./repository", () => ({
  getDefaultTenantId: async () => "tenant-1",
  isAdminProfile: async () => state.adminProfile,
  recordFounderMessage: async (_t: string, m: { waMessageId: string }) => {
    if (state.founderMessages.has(m.waMessageId)) return false;
    state.founderMessages.add(m.waMessageId);
    return true;
  },
  getFounderLastInboundAt: async () => new Date(),
  getApprovalRequest: async (_t: string, id: string) => state.rows.find((r) => r.id === id) ?? null,
  listApprovalRequestsByStatus: async (_t: string, statuses: string[]) =>
    state.rows.filter((r) => statuses.includes(r.status)),
  insertApprovalRequestOnce: async (input: {
    transferRequestId: string;
    clientId: string;
    kind: string;
    round: number;
    status: string;
    proposedAmountCents: number | null;
    proposedDepositCents?: number | null;
  }) => {
    const existing = state.rows.find(
      (r) => r.transferRequestId === input.transferRequestId && r.kind === input.kind && r.round === input.round,
    );
    if (existing) return existing;
    const openStatuses = ["awaiting_decision", "awaiting_price", "processing"];
    if (
      openStatuses.includes(input.status) &&
      state.rows.some((r) => r.transferRequestId === input.transferRequestId && openStatuses.includes(r.status))
    ) {
      return null;
    }
    const row = {
      id: uuid(state.nextId++),
      tenantId: "tenant-1",
      transferRequestId: input.transferRequestId,
      clientId: input.clientId,
      kind: input.kind,
      round: input.round,
      status: input.status,
      proposedAmountCents: input.proposedAmountCents,
      proposedDepositCents: input.proposedDepositCents ?? null,
      notificationStatus: "pending",
      notificationChannel: null,
      notificationError: null,
      notifiedAt: null,
      decidedAt: null,
      decisionError: null,
      customerCommunicationId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as QuoteApprovalRequest;
    state.rows.push(row);
    return row;
  },
  transitionApprovalRequest: async (
    _t: string,
    id: string,
    from: string[],
    to: string,
    extra: Record<string, unknown> = {},
  ) => {
    const row = state.rows.find((r) => r.id === id);
    if (!row || !from.includes(row.status)) return null;
    Object.assign(row, { status: to, ...extra });
    return row;
  },
  claimNotification: async (_t: string, id: string) => {
    const row = state.rows.find((r) => r.id === id);
    if (!row || row.notificationStatus !== "pending") return false;
    row.notificationStatus = "sending";
    return true;
  },
  recordNotificationOutcome: async (_t: string, id: string, outcome: { status: string; channel: string | null }) => {
    const row = state.rows.find((r) => r.id === id);
    if (row) Object.assign(row, { notificationStatus: outcome.status, notificationChannel: outcome.channel });
  },
}));

vi.mock("./founder-channel", () => ({
  sendToFounder: async (_t: string, message: { parts: string[]; buttons?: Array<{ id: string; title: string }> }) => {
    state.founderOutbox.push(message);
    return { channel: "whatsapp", error: null };
  },
}));

const acceptTransferRequest = vi.fn(async (_t: string, id: string, _approver: string, deposit: number) => {
  const tr = state.transferRequests.get(id)!;
  Object.assign(tr, { status: "approved", finalAmountCents: tr.finalAmountCents ?? tr.calculatedAmountCents });
  createBookingFor(id, tr.finalAmountCents!, deposit);
  return tr;
});
const modifyPriceForTransferRequest = vi.fn(
  async (_t: string, id: string, _p: string, amount: number, _reason: string, deposit: number) => {
    const tr = state.transferRequests.get(id)!;
    Object.assign(tr, { status: "approved", finalAmountCents: amount });
    createBookingFor(id, amount, deposit);
    return tr;
  },
);
const rejectTransferRequest = vi.fn(async (_t: string, id: string) => {
  const tr = state.transferRequests.get(id)!;
  Object.assign(tr, { status: "cancelled", cancelledReason: "rejected_by_admin" });
  return tr;
});
vi.mock("../transfer-requests", () => ({
  getTransferRequest: async (_t: string, id: string) => state.transferRequests.get(id) ?? null,
  acceptTransferRequest: (...args: [string, string, string, number]) => acceptTransferRequest(...args),
  modifyPriceForTransferRequest: (...args: [string, string, string, number, string, number]) =>
    modifyPriceForTransferRequest(...args),
  rejectTransferRequest: (...args: [string, string]) => rejectTransferRequest(...args),
}));

const confirmBookingDeposit = vi.fn(async (_t: string, id: string) => {
  const booking = state.bookings.find((b) => b.id === id);
  if (!booking) return null;
  if (booking.status !== "pending_deposit") return { booking, changed: false };
  Object.assign(booking, { status: "confirmed", depositPaidAt: new Date() });
  return { booking, changed: true };
});
vi.mock("../bookings", () => ({
  getBooking: async (_t: string, id: string) => state.bookings.find((b) => b.id === id) ?? null,
  getBookingByTransferRequestId: async (_t: string, trId: string) =>
    state.bookings.find((b) => b.transferRequestId === trId) ?? null,
  listPendingDepositBookings: async () => state.bookings.filter((b) => b.status === "pending_deposit"),
  confirmBookingDeposit: (...args: [string, string]) => confirmBookingDeposit(...args),
}));

vi.mock("../clients", () => ({
  getClient: async () => ({ id: "client-1", fullName: "Mario Rossi", phone: "393331234567" }),
}));

vi.mock("../whatsapp", () => ({
  getLastInboundWhatsappPhoneE164: async () => state.customerPhone,
  normalizePhone: (phone: string) => phone.replace(/[^0-9]/g, ""),
}));

const sendMissingInfoRequest = vi.fn(async (input: { content: { body: string } }) => {
  const failed = state.sendResult === "execution_failed";
  return {
    communication: {
      id: "comm-missing",
      status: state.sendResult,
      error: failed ? "24h window closed" : null,
      content: input.content,
    },
    attempted: true,
  };
});

vi.mock("../communications", async () => {
  const content = await vi.importActual<typeof import("../communications/content")>("../communications/content");
  return {
    ...content,
    sendMissingInfoRequest: (input: { content: { body: string } }) => sendMissingInfoRequest(input),
    prepareTransferQuoteOfferCommunication: async (input: { transferRequestId: string; content: unknown }) => {
      const id = `comm-offer-${input.transferRequestId}`;
      if (!state.communications.has(id)) {
        state.communications.set(id, { id, status: "prepared", error: null, content: input.content });
      }
      return state.communications.get(id);
    },
    submitCommunicationForApproval: async (_t: string, id: string) => {
      const c = state.communications.get(id)!;
      if (c.status === "prepared") c.status = "pending_approval";
      return c;
    },
    approveCommunication: async (_t: string, id: string) => {
      const c = state.communications.get(id)!;
      if (c.status === "pending_approval") c.status = "approved";
      return c;
    },
    executeCommunicationDetailed: async (_t: string, id: string) => {
      const c = state.communications.get(id)!;
      if (c.status !== "approved") return { communication: c, attempted: false };
      state.customerSends++;
      c.status = state.sendResult;
      c.error = state.sendResult === "execution_failed" ? "24h window closed" : null;
      return { communication: c, attempted: true };
    },
    // Same idempotency as the real one: one confirmation per booking, sent
    // (attempted) once.
    sendBookingConfirmation: async (input: { bookingId: string; content: unknown }) => {
      const existing = state.confirmations.get(input.bookingId);
      if (existing) return { communication: existing, attempted: false };
      const failed = state.confirmationSendResult === "execution_failed";
      const c = {
        id: `comm-confirm-${input.bookingId}`,
        status: state.confirmationSendResult,
        error: failed ? "24h window closed" : null,
        content: input.content,
      };
      state.confirmations.set(input.bookingId, c);
      return { communication: c, attempted: true };
    },
  };
});

const {
  handleCustomerMessageOutcome,
  handleFounderMessage,
  approveQuoteRound,
  rejectQuoteRound,
  reviseQuoteRound,
  listPendingForPanel,
  getRoundForPanel,
  confirmDepositReceived,
} = await import("./service");

function transferRequest(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    id: "a1b2c3d4-0000-4000-8000-000000000001",
    tenantId: "tenant-1",
    clientId: "client-1",
    dealId: "deal-1",
    status: "pending_admin_approval",
    intent: "transfer_request",
    pickup: "Malpensa",
    pickupAddress: null,
    destination: "Sondrio",
    destinationAddress: null,
    requestedDate: "2026-10-03",
    requestedTime: "14:30",
    passengers: 2,
    luggage: null,
    children: null,
    childrenAges: null,
    flightNumber: "AZ123",
    trainNumber: null,
    hotel: null,
    language: "it",
    missingInformation: [],
    pricingStatus: "fixed",
    calculatedAmountCents: 30000,
    currency: "EUR",
    pricingBreakdown: null,
    quoteId: null,
    adminApprovedAt: null,
    adminApprovedBy: null,
    cancelledReason: null,
    finalAmountCents: null,
    priceOverrideReason: null,
    customerTripDurationMinutes: null,
    availabilityBreakdown: { status: "verified", feasibility: { feasible: true } },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as TransferRequest;
}

let messageCounter = 0;
function founderTap(buttonId: string) {
  return handleFounderMessage({
    waMessageId: `wamid.founder-${++messageCounter}`,
    type: "interactive",
    rawText: null,
    buttonId,
    receivedAt: new Date(),
  });
}
function founderText(text: string) {
  return handleFounderMessage({
    waMessageId: `wamid.founder-${++messageCounter}`,
    type: "text",
    rawText: text,
    receivedAt: new Date(),
  });
}

async function notifyQuoteReady(tr: TransferRequest) {
  state.transferRequests.set(tr.id, tr);
  await handleCustomerMessageOutcome({
    tenantId: "tenant-1",
    clientId: "client-1",
    inboundMessageRowId: "msg-1",
    fromPhone: "393331234567",
    extracted: { pickup: tr.pickup ?? undefined },
    transferRequest: tr,
  });
}

function lastFounderButtons() {
  const withButtons = state.founderOutbox.filter((m) => m.buttons);
  return withButtons[withButtons.length - 1]!.buttons!;
}

function buttonFor(action: "APPROVA" | "MODIFICA" | "RIFIUTA") {
  return lastFounderButtons().find((b) => b.title === action)!.id;
}

beforeEach(() => {
  state.rows = [];
  state.founderMessages = new Set();
  state.nextId = 1;
  state.transferRequests = new Map();
  state.communications = new Map();
  state.founderOutbox = [];
  state.customerSends = 0;
  state.adminProfile = true;
  state.customerPhone = "+393331234567";
  state.sendResult = "executed";
  state.bookings = [];
  state.confirmations = new Map();
  state.confirmationSendResult = "executed";
  confirmBookingDeposit.mockClear();
  process.env.QUOTE_APPROVAL_ENABLED = "true";
  delete process.env.QUOTE_APPROVAL_TEST_PHONES;
  process.env.FOUNDER_PROFILE_ID = "profile-founder";
  acceptTransferRequest.mockClear();
  modifyPriceForTransferRequest.mockClear();
  rejectTransferRequest.mockClear();
  sendMissingInfoRequest.mockClear();
});

describe("missing information", () => {
  it("asks the customer for the missing fields plus children and luggage, without a price", async () => {
    const tr = transferRequest({
      status: "collecting_info",
      requestedTime: null,
      passengers: null,
      missingInformation: ["passengers", "time"],
      pricingStatus: "not_priced",
      calculatedAmountCents: null,
    });
    await handleCustomerMessageOutcome({
      tenantId: "tenant-1",
      clientId: "client-1",
      inboundMessageRowId: "msg-7",
      fromPhone: "393331234567",
      extracted: { pickup: "Malpensa" },
      transferRequest: tr,
    });

    expect(sendMissingInfoRequest).toHaveBeenCalledTimes(1);
    const input = sendMissingInfoRequest.mock.calls[0]![0] as unknown as {
      inboundMessageRowId: string;
      content: { to: string; body: string };
    };
    expect(input.inboundMessageRowId).toBe("msg-7");
    expect(input.content.to).toBe("+393331234567");
    expect(input.content.body).toContain("numero di passeggeri");
    expect(input.content.body).toContain("orario");
    expect(input.content.body).toContain("quanti bambini viaggiano e la loro età");
    expect(input.content.body).toContain("quanti bagagli");
    expect(input.content.body).not.toMatch(/€|taxi/i);
    expect(state.founderOutbox).toHaveLength(0);
  });

  it("does not ask anything for a message that is not about a trip", async () => {
    const tr = transferRequest({ status: "collecting_info", missingInformation: ["pickup"] });
    await handleCustomerMessageOutcome({
      tenantId: "tenant-1",
      clientId: "client-1",
      inboundMessageRowId: "msg-8",
      fromPhone: "393331234567",
      extracted: { intent: "greeting" },
      transferRequest: tr,
    });
    expect(sendMissingInfoRequest).not.toHaveBeenCalled();
  });

  it("writes in English for a foreign customer", async () => {
    const tr = transferRequest({ status: "collecting_info", language: "English", missingInformation: ["date"] });
    await handleCustomerMessageOutcome({
      tenantId: "tenant-1",
      clientId: "client-1",
      inboundMessageRowId: "msg-9",
      fromPhone: "447700900123",
      extracted: { destination: "Sondrio" },
      transferRequest: tr,
    });
    const input = sendMissingInfoRequest.mock.calls[0]![0] as unknown as { content: { body: string } };
    expect(input.content.body).toContain("travel date");
    expect(input.content.body).toContain("how many children");
  });
});

describe("PREVENTIVO PRONTO", () => {
  it("notifies the founder once with the three buttons and the customer text, sending nothing to the customer", async () => {
    const tr = transferRequest();
    await notifyQuoteReady(tr);
    await notifyQuoteReady(tr);

    expect(state.founderOutbox).toHaveLength(1);
    const message = state.founderOutbox[0]!;
    const text = message.parts.join("\n");
    expect(text).toContain("PREVENTIVO PRONTO");
    expect(text).toContain("Malpensa → Sondrio");
    expect(text).toContain("300,00 €");
    expect(text).toContain("Bambini: non indicato");
    expect(text).toContain("Messaggio che riceverà il cliente");
    expect(message.buttons!.map((b) => b.title)).toEqual(["APPROVA", "MODIFICA", "RIFIUTA"]);
    expect(state.customerSends).toBe(0);
  });

  it("APPROVA approves and sends the quote to the customer exactly once, even on a double tap", async () => {
    await notifyQuoteReady(transferRequest());
    const approve = buttonFor("APPROVA");

    await founderTap(approve);
    await founderTap(approve);

    expect(acceptTransferRequest).toHaveBeenCalledTimes(1);
    expect(state.customerSends).toBe(1);
    const offer = [...state.communications.values()][0]!.content as { to: string; body: string };
    expect(offer.to).toBe("+393331234567");
    expect(offer.body).toContain("Prezzo totale: 300,00 €");
    expect(offer.body).toContain("Acconto per confermare la prenotazione: 150,00 €");
    expect(offer.body).not.toMatch(/taxi/i);
    // Besides the replies, one "IN ATTESA DI ACCONTO" notice for the new booking.
    const replies = state.founderOutbox
      .slice(1)
      .map((m) => m.parts.join(""))
      .filter((text) => !text.startsWith("IN ATTESA DI ACCONTO"));
    expect(replies[0]).toContain("approvato");
    expect(replies[1]).toContain("già approvato");
    expect(state.founderOutbox.filter((m) => m.parts.join("").startsWith("IN ATTESA DI ACCONTO"))).toHaveLength(1);
  });

  it("a Meta retry of the same tap is ignored", async () => {
    await notifyQuoteReady(transferRequest());
    const approve = buttonFor("APPROVA");
    const tap = { waMessageId: "wamid.same", type: "interactive", rawText: null, buttonId: approve, receivedAt: new Date() };
    await handleFounderMessage(tap);
    await handleFounderMessage(tap);
    expect(acceptTransferRequest).toHaveBeenCalledTimes(1);
    // PREVENTIVO PRONTO, IN ATTESA DI ACCONTO, the reply — nothing for the retry.
    expect(state.founderOutbox).toHaveLength(3);
  });

  it("RIFIUTA rejects and sends nothing to the customer", async () => {
    await notifyQuoteReady(transferRequest());
    await founderTap(buttonFor("RIFIUTA"));
    await founderTap(buttonFor("APPROVA"));

    expect(rejectTransferRequest).toHaveBeenCalledTimes(1);
    expect(acceptTransferRequest).not.toHaveBeenCalled();
    expect(state.customerSends).toBe(0);
    const replies = state.founderOutbox.slice(1).map((m) => m.parts.join(""));
    expect(replies[0]).toContain("rifiutato");
    expect(replies[1]).toContain("già rifiutato");
  });

  it("MODIFICA asks the price, re-sends PREVENTIVO PRONTO, and only the new APPROVA sends it", async () => {
    await notifyQuoteReady(transferRequest());
    const oldApprove = buttonFor("APPROVA");

    await founderTap(buttonFor("MODIFICA"));
    expect(state.founderOutbox[state.founderOutbox.length - 1]!.parts.join("")).toContain("scrivi il nuovo prezzo");

    await founderText("280");
    expect(state.customerSends).toBe(0);
    const newMessage = state.founderOutbox[state.founderOutbox.length - 1]!;
    expect(newMessage.parts.join("\n")).toContain("PREVENTIVO PRONTO (prezzo modificato)");
    expect(newMessage.parts.join("\n")).toContain("280,00 €");

    await founderTap(oldApprove);
    expect(state.customerSends).toBe(0);
    expect(state.founderOutbox[state.founderOutbox.length - 1]!.parts.join("")).toContain("non è più valido");

    await founderTap(buttonFor("APPROVA"));
    expect(modifyPriceForTransferRequest).toHaveBeenCalledWith(
      "tenant-1",
      "a1b2c3d4-0000-4000-8000-000000000001",
      "profile-founder",
      28000,
      expect.any(String),
      14000, // default deposit on the new price
    );
    expect(acceptTransferRequest).not.toHaveBeenCalled();
    expect(state.customerSends).toBe(1);
    const offer = [...state.communications.values()][0]!.content as { body: string };
    expect(offer.body).toContain("Prezzo totale: 280,00 €");
    expect(offer.body).toContain("Acconto per confermare la prenotazione: 140,00 €");
  });

  it("any other founder message re-sends every pending PREVENTIVO PRONTO", async () => {
    await notifyQuoteReady(transferRequest());
    await notifyQuoteReady(transferRequest({ id: "b1b2c3d4-0000-4000-8000-000000000002", pickup: "Linate" }));
    state.founderOutbox = [];

    await founderText("ciao");

    expect(state.founderOutbox).toHaveLength(2);
    expect(state.founderOutbox.every((m) => m.buttons?.length === 3)).toBe(true);
    expect(state.customerSends).toBe(0);
  });

  it("a typed APPROVA does nothing but point to the buttons", async () => {
    await notifyQuoteReady(transferRequest());
    state.founderOutbox = [];

    await founderText("APPROVA");

    expect(acceptTransferRequest).not.toHaveBeenCalled();
    expect(state.founderOutbox[0]!.parts.join("")).toContain("pulsanti");
    expect(state.founderOutbox[1]!.buttons).toHaveLength(3);
  });

  it("says so when nothing is pending", async () => {
    await founderText("ciao");
    expect(state.founderOutbox[0]!.parts.join("")).toContain("Nessun preventivo in attesa");
  });

  it("refuses to approve without a valid FOUNDER_PROFILE_ID and leaves the quote pending", async () => {
    await notifyQuoteReady(transferRequest());
    state.adminProfile = false;
    await founderTap(buttonFor("APPROVA"));
    expect(acceptTransferRequest).not.toHaveBeenCalled();
    expect(state.rows[0]!.status).toBe("awaiting_decision");
  });

  it("releases the claim when approval fails, so the same button can retry", async () => {
    await notifyQuoteReady(transferRequest());
    acceptTransferRequest.mockRejectedValueOnce(new Error("booking creation failed"));

    await founderTap(buttonFor("APPROVA"));
    expect(state.rows[0]!.status).toBe("awaiting_decision");
    expect(state.customerSends).toBe(0);

    await founderTap(buttonFor("APPROVA"));
    expect(state.customerSends).toBe(1);
  });

  it("does not send when the request was already decided elsewhere", async () => {
    const tr = transferRequest();
    await notifyQuoteReady(tr);
    tr.status = "cancelled";
    await founderTap(buttonFor("APPROVA"));
    expect(state.customerSends).toBe(0);
    expect(state.founderOutbox[state.founderOutbox.length - 1]!.parts.join("")).toContain("non è più in attesa");
  });
});

describe("PREZZO DA INSERIRE", () => {
  it("notifies the founder without buttons when the price needs manual work", async () => {
    const tr = transferRequest({
      status: "ready_for_pricing",
      pricingStatus: "manual_required",
      calculatedAmountCents: null,
      pricingBreakdown: { manualRequiredReason: "hourly_service" },
    });
    await handleCustomerMessageOutcome({
      tenantId: "tenant-1",
      clientId: "client-1",
      inboundMessageRowId: "msg-3",
      fromPhone: "393331234567",
      extracted: {},
      transferRequest: tr,
    });

    expect(state.founderOutbox).toHaveLength(1);
    expect(state.founderOutbox[0]!.parts.join("")).toContain("PREZZO DA INSERIRE");
    expect(state.founderOutbox[0]!.buttons).toBeUndefined();
  });
});

describe("QUOTE_APPROVAL_ENABLED", () => {
  it("off: no question, no PREVENTIVO PRONTO, founder messages ignored", async () => {
    process.env.QUOTE_APPROVAL_ENABLED = "false";

    await handleCustomerMessageOutcome({
      tenantId: "tenant-1",
      clientId: "client-1",
      inboundMessageRowId: "msg-1",
      fromPhone: "393331234567",
      extracted: { pickup: "Malpensa" },
      transferRequest: transferRequest({ status: "collecting_info", missingInformation: ["date"] }),
    });
    await notifyQuoteReady(transferRequest());
    await founderText("ciao");

    expect(sendMissingInfoRequest).not.toHaveBeenCalled();
    expect(state.rows).toHaveLength(0);
    expect(state.founderOutbox).toHaveLength(0);
    expect(state.founderMessages.size).toBe(0);
  });

  it("turned off after a PREVENTIVO PRONTO: a later APPROVA tap sends nothing", async () => {
    await notifyQuoteReady(transferRequest());
    const approve = buttonFor("APPROVA");
    process.env.QUOTE_APPROVAL_ENABLED = "false";

    await founderTap(approve);

    expect(acceptTransferRequest).not.toHaveBeenCalled();
    expect(state.customerSends).toBe(0);
  });
});

describe("QUOTE_APPROVAL_TEST_PHONES", () => {
  it("a listed customer gets the full flow", async () => {
    process.env.QUOTE_APPROVAL_TEST_PHONES = "+393331234567";

    await handleCustomerMessageOutcome({
      tenantId: "tenant-1",
      clientId: "client-1",
      inboundMessageRowId: "msg-1",
      fromPhone: "393331234567",
      extracted: { pickup: "Malpensa" },
      transferRequest: transferRequest({ status: "collecting_info", missingInformation: ["date"] }),
    });
    await notifyQuoteReady(transferRequest());
    await founderTap(buttonFor("APPROVA"));

    expect(sendMissingInfoRequest).toHaveBeenCalledTimes(1);
    expect(state.customerSends).toBe(1);
  });

  it("any other customer gets nothing automatic and produces no PREVENTIVO PRONTO", async () => {
    process.env.QUOTE_APPROVAL_TEST_PHONES = "+393330000000";

    await handleCustomerMessageOutcome({
      tenantId: "tenant-1",
      clientId: "client-1",
      inboundMessageRowId: "msg-1",
      fromPhone: "393331234567",
      extracted: { pickup: "Malpensa" },
      transferRequest: transferRequest({ status: "collecting_info", missingInformation: ["date"] }),
    });
    await notifyQuoteReady(transferRequest());

    expect(sendMissingInfoRequest).not.toHaveBeenCalled();
    expect(state.rows).toHaveLength(0);
    expect(state.founderOutbox).toHaveLength(0);
  });

  it("APPROVA never approves or sends to a customer outside the list", async () => {
    await notifyQuoteReady(transferRequest());
    const approve = buttonFor("APPROVA");
    process.env.QUOTE_APPROVAL_TEST_PHONES = "+393330000000";

    await founderTap(approve);

    expect(acceptTransferRequest).not.toHaveBeenCalled();
    expect(state.customerSends).toBe(0);
    expect(state.rows[0]!.status).toBe("awaiting_decision");
    expect(state.founderOutbox[state.founderOutbox.length - 1]!.parts.join("")).toContain("numeri di prova");
  });

  it("re-sending pending quotes skips customers outside the list", async () => {
    await notifyQuoteReady(transferRequest());
    process.env.QUOTE_APPROVAL_TEST_PHONES = "+393330000000";
    state.founderOutbox = [];

    await founderText("ciao");

    expect(state.founderOutbox).toHaveLength(1);
    expect(state.founderOutbox[0]!.parts.join("")).toContain("Nessun preventivo in attesa");
  });
});

describe("admin panel decisions", () => {
  const STAFF = "profile-staff";

  function openRound() {
    return state.rows.find((r) => r.status === "awaiting_decision")!;
  }

  it("Approva approves with the logged-in profile and sends the quote; a double click sends nothing more", async () => {
    await notifyQuoteReady(transferRequest());
    const id = openRound().id;

    const first = await approveQuoteRound("tenant-1", id, STAFF);
    const second = await approveQuoteRound("tenant-1", id, STAFF);

    expect(first.outcome).toBe("done");
    expect(first.message).toContain("approvato");
    expect(second.outcome).toBe("already");
    expect(second.message).toContain("già approvato");
    expect(acceptTransferRequest).toHaveBeenCalledTimes(1);
    expect(acceptTransferRequest.mock.calls[0]![2]).toBe(STAFF);
    expect(state.customerSends).toBe(1);
  });

  it("Rifiuta rejects and sends nothing", async () => {
    await notifyQuoteReady(transferRequest());
    const result = await rejectQuoteRound("tenant-1", openRound().id);
    expect(result.outcome).toBe("done");
    expect(state.customerSends).toBe(0);
    expect(rejectTransferRequest).toHaveBeenCalledTimes(1);
  });

  it("Modifica opens a new round without emailing it; the old round can no longer be approved", async () => {
    await notifyQuoteReady(transferRequest());
    const oldId = openRound().id;
    const outboxBefore = state.founderOutbox.length;

    const revised = await reviseQuoteRound("tenant-1", oldId, 28000, null, { notify: false });

    expect(revised.outcome).toBe("done");
    expect(revised.newRoundId).toBeDefined();
    expect(state.founderOutbox).toHaveLength(outboxBefore);
    expect((await approveQuoteRound("tenant-1", oldId, STAFF)).message).toContain("non è più valido");

    const approved = await approveQuoteRound("tenant-1", revised.newRoundId!, STAFF);
    expect(approved.outcome).toBe("done");
    expect(modifyPriceForTransferRequest).toHaveBeenCalledWith(
      "tenant-1",
      expect.any(String),
      STAFF,
      28000,
      expect.any(String),
      14000,
    );
    expect(state.customerSends).toBe(1);
  });

  it("Modifica refuses a non-positive price", async () => {
    await notifyQuoteReady(transferRequest());
    const result = await reviseQuoteRound("tenant-1", openRound().id, 0, null, { notify: false });
    expect(result.outcome).toBe("refused");
    expect(state.rows).toHaveLength(1);
  });

  it("with the flow off every decision is refused and nothing happens", async () => {
    await notifyQuoteReady(transferRequest());
    const id = openRound().id;
    process.env.QUOTE_APPROVAL_ENABLED = "false";

    for (const result of [
      await approveQuoteRound("tenant-1", id, STAFF),
      await rejectQuoteRound("tenant-1", id),
      await reviseQuoteRound("tenant-1", id, 28000, null, { notify: false }),
    ]) {
      expect(result.outcome).toBe("refused");
      expect(result.message).toContain("disattivato");
    }
    expect(acceptTransferRequest).not.toHaveBeenCalled();
    expect(rejectTransferRequest).not.toHaveBeenCalled();
    expect((await listPendingForPanel("tenant-1")).enabled).toBe(false);
  });

  it("test mode: Approva refuses a customer outside QUOTE_APPROVAL_TEST_PHONES and approves nothing", async () => {
    await notifyQuoteReady(transferRequest());
    process.env.QUOTE_APPROVAL_TEST_PHONES = "+393330000000";
    const result = await approveQuoteRound("tenant-1", openRound().id, STAFF);
    expect(result.outcome).toBe("refused");
    expect(acceptTransferRequest).not.toHaveBeenCalled();
    expect(openRound()).toBeDefined();
  });
});

describe("alerts when a message to the customer does not go out", () => {
  function alerts() {
    return state.founderOutbox.filter((m) => m.parts.join("").includes("INVIO AL CLIENTE NON RIUSCITO"));
  }

  it("alerts once when the missing-information question fails", async () => {
    state.sendResult = "execution_failed";
    await handleCustomerMessageOutcome({
      tenantId: "tenant-1",
      clientId: "client-1",
      inboundMessageRowId: "msg-1",
      fromPhone: "393331234567",
      extracted: { pickup: "Malpensa" },
      transferRequest: transferRequest({ status: "collecting_info", missingInformation: ["date"] }),
    });
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.parts.join("")).toContain("la domanda sui dati mancanti");
    expect(alerts()[0]!.parts.join("")).toContain("24h window closed");
  });

  it("alerts once when the quote fails, and not again on a later click", async () => {
    await notifyQuoteReady(transferRequest());
    const id = state.rows[0]!.id;
    state.sendResult = "execution_failed";

    const result = await approveQuoteRound("tenant-1", id, "profile-staff");
    await approveQuoteRound("tenant-1", id, "profile-staff");

    expect(result.message).toContain("NON è partito");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.parts.join("")).toContain("il preventivo");
  });

  it("no alert when the send goes out", async () => {
    await notifyQuoteReady(transferRequest());
    await approveQuoteRound("tenant-1", state.rows[0]!.id, "profile-staff");
    expect(alerts()).toHaveLength(0);
  });
});

describe("panel views and email links", () => {
  it("lists pending quotes with the exact customer text", async () => {
    await notifyQuoteReady(transferRequest());
    const pending = await listPendingForPanel("tenant-1");
    expect(pending.enabled).toBe(true);
    expect(pending.quotes).toHaveLength(1);
    expect(pending.quotes[0]!.view.customerPreview).toContain("Prezzo totale: 300,00 € per l'intero veicolo");
    expect(pending.quotes[0]!.view.founderDetails).toContain("PREVENTIVO PRONTO");
  });

  it("a superseded round points to the newest open one", async () => {
    await notifyQuoteReady(transferRequest());
    const oldId = state.rows[0]!.id;
    const revised = await reviseQuoteRound("tenant-1", oldId, 28000, null, { notify: false });

    const oldView = await getRoundForPanel("tenant-1", oldId);
    const newView = await getRoundForPanel("tenant-1", revised.newRoundId!);
    expect(oldView?.open).toBe(false);
    expect(oldView?.latestOpenRoundId).toBe(revised.newRoundId);
    expect(newView?.open).toBe(true);
    expect(newView?.view.amountCents).toBe(28000);
  });

  it("PREVENTIVO PRONTO links to the quote page when ADMIN_BASE_URL is set, and has no link otherwise", async () => {
    process.env.ADMIN_BASE_URL = "https://bonolini-operating-system-transfer.vercel.app/";
    await notifyQuoteReady(transferRequest());
    const withLink = state.founderOutbox[0] as { link?: { url: string } | null };
    expect(withLink.link?.url).toBe(
      `https://bonolini-operating-system-transfer.vercel.app/preventivi/${state.rows[0]!.id}`,
    );

    delete process.env.ADMIN_BASE_URL;
    await notifyQuoteReady(transferRequest({ id: "b1b2c3d4-0000-4000-8000-000000000002" }));
    const withoutLink = state.founderOutbox[1] as { link?: { url: string } | null };
    expect(withoutLink.link).toBeNull();
  });
});

describe("deposit", () => {
  const STAFF = "profile-staff";

  function lastOutbox() {
    return state.founderOutbox[state.founderOutbox.length - 1]!;
  }
  function openRound() {
    return state.rows.find((r) => r.status === "awaiting_decision")!;
  }
  function confirmationsSent() {
    return [...state.confirmations.values()];
  }

  it("PREVENTIVO PRONTO shows the proposed deposit (50%, nearest 10 €) and the balance", async () => {
    await notifyQuoteReady(transferRequest({ calculatedAmountCents: 39000 }));
    const text = state.founderOutbox[0]!.parts.join("\n");
    expect(text).toContain("Acconto: 200,00 € (50%, arrotondato) — saldo all'autista 190,00 €");
    expect(text).toContain("Acconto per confermare la prenotazione: 200,00 €");
  });

  it("Approva creates the booking waiting for the deposit and emails IN ATTESA DI ACCONTO with a link", async () => {
    process.env.ADMIN_BASE_URL = "https://admin.example";
    await notifyQuoteReady(transferRequest());
    const result = await approveQuoteRound("tenant-1", openRound().id, STAFF);
    delete process.env.ADMIN_BASE_URL;

    expect(result.message).toContain("in attesa di acconto (150,00 €)");
    expect(acceptTransferRequest).toHaveBeenCalledWith("tenant-1", expect.any(String), STAFF, 15000);
    expect(state.bookings[0]).toMatchObject({ status: "pending_deposit", depositAmountCents: 15000 });
    const notice = lastOutbox() as { parts: string[]; link?: { url: string } | null };
    expect(notice.parts.join("")).toContain("IN ATTESA DI ACCONTO");
    expect(notice.parts.join("")).toContain("Acconto da ricevere: 150,00 €");
    expect(notice.link?.url).toBe("https://admin.example/customers/client-1");
    expect(confirmBookingDeposit).not.toHaveBeenCalled();
  });

  it("Modifica with price and deposit: the approval and the customer quote use both", async () => {
    await notifyQuoteReady(transferRequest());
    const revised = await reviseQuoteRound("tenant-1", openRound().id, 28000, 10000, { notify: false });
    await approveQuoteRound("tenant-1", revised.newRoundId!, STAFF);

    expect(modifyPriceForTransferRequest).toHaveBeenCalledWith(
      "tenant-1",
      expect.any(String),
      STAFF,
      28000,
      expect.any(String),
      10000,
    );
    const offer = [...state.communications.values()][0]!.content as { body: string };
    expect(offer.body).toContain("Acconto per confermare la prenotazione: 100,00 €");
    expect(offer.body).toContain("Saldo all'autista il giorno del servizio: 180,00 €");
  });

  it("Modifica refuses a deposit above the price and changes nothing", async () => {
    await notifyQuoteReady(transferRequest());
    const result = await reviseQuoteRound("tenant-1", openRound().id, 28000, 30000, { notify: false });
    expect(result.outcome).toBe("refused");
    expect(result.message).toContain("acconto deve essere maggiore di zero e non superiore al prezzo");
    expect(state.rows).toHaveLength(1);
  });

  it("Acconto ricevuto (panel) confirms the booking and sends the confirmation once, even on a double click", async () => {
    await notifyQuoteReady(transferRequest());
    await approveQuoteRound("tenant-1", openRound().id, STAFF);
    const bookingId = state.bookings[0]!.id as string;

    const first = await confirmDepositReceived("tenant-1", bookingId);
    const second = await confirmDepositReceived("tenant-1", bookingId);

    expect(first.outcome).toBe("done");
    expect(first.message).toContain("prenotazione CONFERMATA");
    expect(second.outcome).toBe("already");
    expect(second.message).toContain("era già confermata");
    expect(state.bookings[0]!.status).toBe("confirmed");
    expect(confirmationsSent()).toHaveLength(1);
    const confirmation = confirmationsSent()[0]!.content as { to: string; body: string };
    expect(confirmation.to).toBe("+393331234567");
    expect(confirmation.body).toContain("Data: 3 ottobre 2026, ore 14:30");
    expect(confirmation.body).toContain(
      "Saldo all'autista il giorno del servizio: 150,00 € (preferibilmente in contanti)",
    );
  });

  it("records a different amount received when given", async () => {
    await notifyQuoteReady(transferRequest());
    await approveQuoteRound("tenant-1", openRound().id, STAFF);
    await confirmDepositReceived("tenant-1", state.bookings[0]!.id as string, 12000);
    expect(confirmBookingDeposit).toHaveBeenCalledWith("tenant-1", state.bookings[0]!.id, 12000);
  });

  it("emails INVIO AL CLIENTE NON RIUSCITO once when the confirmation does not go out", async () => {
    await notifyQuoteReady(transferRequest());
    await approveQuoteRound("tenant-1", openRound().id, STAFF);
    state.confirmationSendResult = "execution_failed";
    const bookingId = state.bookings[0]!.id as string;

    const result = await confirmDepositReceived("tenant-1", bookingId);
    await confirmDepositReceived("tenant-1", bookingId);

    expect(state.bookings[0]!.status).toBe("confirmed");
    expect(result.message).toContain("NON è partito: 24h window closed");
    const alerts = state.founderOutbox.filter((m) => m.parts.join("").includes("INVIO AL CLIENTE NON RIUSCITO"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.parts.join("")).toContain("la conferma della prenotazione");
  });

  it("never confirms a cancelled booking and sends nothing", async () => {
    await notifyQuoteReady(transferRequest());
    await approveQuoteRound("tenant-1", openRound().id, STAFF);
    state.bookings[0]!.status = "cancelled";

    const result = await confirmDepositReceived("tenant-1", state.bookings[0]!.id as string);

    expect(result.outcome).toBe("refused");
    expect(result.message).toContain('in stato "cancelled"');
    expect(confirmationsSent()).toHaveLength(0);
  });

  it("respects the switches: off -> refused; customer outside the test list -> refused, booking untouched", async () => {
    await notifyQuoteReady(transferRequest());
    await approveQuoteRound("tenant-1", openRound().id, STAFF);
    const bookingId = state.bookings[0]!.id as string;

    process.env.QUOTE_APPROVAL_ENABLED = "false";
    expect((await confirmDepositReceived("tenant-1", bookingId)).message).toContain("disattivato");

    process.env.QUOTE_APPROVAL_ENABLED = "true";
    process.env.QUOTE_APPROVAL_TEST_PHONES = "+393330000000";
    expect((await confirmDepositReceived("tenant-1", bookingId)).message).toContain("numeri di prova");

    expect(confirmBookingDeposit).not.toHaveBeenCalled();
    expect(state.bookings[0]!.status).toBe("pending_deposit");
  });

  it("the panel lists bookings waiting for their deposit", async () => {
    await notifyQuoteReady(transferRequest());
    await approveQuoteRound("tenant-1", openRound().id, STAFF);
    const pending = await listPendingForPanel("tenant-1");
    expect(pending.quotes).toHaveLength(0);
    expect(pending.pendingDeposits).toHaveLength(1);
    expect(pending.pendingDeposits[0]!.depositLabel).toBe("150,00 €");
  });

  it("dormant WhatsApp path: the ACCONTO RICEVUTO button does the same as the panel", async () => {
    await notifyQuoteReady(transferRequest());
    await founderTap(buttonFor("APPROVA"));
    const depositButton = state.founderOutbox
      .flatMap((m) => m.buttons ?? [])
      .find((b) => b.title === "ACCONTO RICEVUTO")!;

    await founderTap(depositButton.id);
    await founderTap(depositButton.id);

    expect(state.bookings[0]!.status).toBe("confirmed");
    expect(confirmationsSent()).toHaveLength(1);
  });
});
