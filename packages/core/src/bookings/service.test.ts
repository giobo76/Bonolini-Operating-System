import { StringChunk, Param } from "drizzle-orm";
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { EnsureBookingSnapshotInput, EnsureBookingFromCalendarEventInput } from "./schema";

// @bos/db fully mocked — same convention as
// packages/core/src/transfer-requests/service.test.ts (no test-database
// strategy exists yet). Covers what both raw-SQL upserts in service.ts need
// (ensureBookingForApprovedTransferRequest's INSERT ... ON CONFLICT DO
// NOTHING, ensureBookingFromCalendarEvent's INSERT ... ON CONFLICT DO
// UPDATE ... WHERE status != 'cancelled') plus real select()/update()
// filtering by (tenantId, transferRequestId|calendarEventId) — needed now
// that more than one booking can coexist in fakeState across a single
// test, unlike this file's original three tests.
const { fakeState, bookingsTable } = vi.hoisted(() => {
  return {
    fakeState: { bookings: [] as Array<Record<string, unknown>>, nextId: 1 },
    bookingsTable: { __name: "bookings" },
  };
});

// Same jobsMock shape/convention as transfer-requests/service.test.ts and
// social-publishing/service.test.ts — emitDomainEvent is asserted on
// directly, never the real Inngest client.
const jobsMock = vi.hoisted(() => ({ inngest: {}, emitDomainEvent: vi.fn() }));
vi.mock("@bos/jobs", () => jobsMock);

const advanceDealStatus = vi.hoisted(() => vi.fn());
vi.mock("../deals", () => ({ advanceDealStatus }));

// Recursively flattens a drizzle and(eq(...), eq(...), sql`...`) condition
// down to its real bound values, in order — StringChunks (literal SQL
// text) and the `undefined` column-reference chunks (the mocked
// bookingsTable has no real Column objects, so `bookings.tenantId` etc.
// resolve to undefined) are both dropped. Verified directly against the
// installed drizzle-orm version (see the codebase's own established
// discipline for this — never assumed).
function extractConditionValues(node: { queryChunks: unknown[] }): unknown[] {
  const values: unknown[] = [];
  for (const chunk of node.queryChunks) {
    if (chunk instanceof StringChunk) continue;
    if (chunk === undefined || chunk === null) continue;
    if (chunk instanceof Param) {
      values.push(chunk.value);
      continue;
    }
    if (typeof chunk === "object" && "queryChunks" in chunk) {
      values.push(...extractConditionValues(chunk as { queryChunks: unknown[] }));
      continue;
    }
    values.push(chunk);
  }
  return values;
}

// Every lookup this module does is (tenantId, transferRequestId),
// (tenantId, calendarEventId), or — now that getBooking/updateBooking are
// exercised too — (tenantId, id). A booking is only ever sourced from one
// path, and fake ids ("booking-1", ...) never collide with the
// transferRequestId/calendarEventId strings used in these tests, so
// matching any of the three against the second extracted value stays
// unambiguous.
function findByTenantAndKey(tenantId: unknown, key: unknown): Record<string, unknown> | undefined {
  return fakeState.bookings.find(
    (b) => b.tenantId === tenantId && (b.id === key || b.transferRequestId === key || b.calendarEventId === key),
  );
}

vi.mock("@bos/db", () => {
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: { queryChunks: unknown[] }) => {
          const values = extractConditionValues(condition);
          // Two-value compound condition -> filter for real. No condition
          // extracted (shouldn't happen for this module) -> passthrough.
          if (values.length >= 2) {
            const match = findByTenantAndKey(values[0], values[1]);
            return Promise.resolve(match ? [match] : []);
          }
          return Promise.resolve(fakeState.bookings);
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: { queryChunks: unknown[] }) => {
          const conditionValues = extractConditionValues(condition);
          const target = findByTenantAndKey(conditionValues[0], conditionValues[1]);
          // Mirrors the real WHERE guards: confirmBookingDeposit's
          // status = 'pending_deposit', and the status != 'cancelled' that
          // cancelBookingByCalendarEventId's SQL expresses — an
          // already-cancelled booking is never touched again, same
          // idempotency guarantee as the raw-SQL upsert below.
          const applies =
            target !== undefined &&
            (conditionValues.includes("pending_deposit")
              ? target.status === "pending_deposit"
              : target.status !== "cancelled");
          if (applies) Object.assign(target, values);
          const result = applies ? [target] : [];
          return { returning: async () => result };
        },
      }),
    }),
    execute: async (query: { queryChunks: unknown[] }) => {
      const sqlText = query.queryChunks
        .filter((chunk): chunk is InstanceType<typeof StringChunk> => chunk instanceof StringChunk)
        .map((chunk) => chunk.value.join(""))
        .join("");
      const params = query.queryChunks.filter((chunk) => !(chunk instanceof StringChunk));

      if (sqlText.includes("calendar_event_id")) {
        const [tenantId, clientId, calendarEventId, pickup, destination, scheduledAt, finalAmountCents, currency] =
          params as [string, string, string, string | null, string | null, string | null, number | null, string];

        const existing = fakeState.bookings.find((b) => b.calendarEventId === calendarEventId);
        if (existing) {
          if (existing.status === "cancelled") return [];
          Object.assign(existing, { pickup, destination, scheduledAt: scheduledAt ? new Date(scheduledAt) : null, finalAmountCents, currency, updatedAt: new Date() });
          return [existing];
        }

        const row: Record<string, unknown> = {
          id: `booking-${fakeState.nextId++}`,
          tenantId,
          clientId,
          transferRequestId: null,
          calendarEventId,
          quoteId: null,
          pickup,
          destination,
          pickupAddress: null,
          destinationAddress: null,
          customerTripDurationMinutes: null,
          status: "confirmed",
          currency,
          depositAmountCents: null,
          depositPaidAt: null,
          finalAmountCents,
          scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
          completedAt: null,
          cancelledAt: null,
          invoicedAt: null,
          invoiceAmountCents: null,
          paidAt: null,
          paidAmountCents: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        fakeState.bookings.push(row);
        return [row];
      }

      const [
        tenantId,
        clientId,
        transferRequestId,
        dealId,
        pickup,
        destination,
        pickupAddress,
        destinationAddress,
        customerTripDurationMinutes,
        scheduledAt,
        finalAmountCents,
        currency,
        status,
        depositAmountCents,
      ] = params as [
        string,
        string,
        string,
        string | null,
        string,
        string,
        string | null,
        string | null,
        number,
        string,
        number,
        string,
        string,
        number,
      ];

      const conflict = fakeState.bookings.some((b) => b.transferRequestId === transferRequestId);
      if (conflict) return [];

      const row: Record<string, unknown> = {
        id: `booking-${fakeState.nextId++}`,
        tenantId,
        clientId,
        transferRequestId,
        dealId,
        calendarEventId: null,
        quoteId: null,
        pickup,
        destination,
        pickupAddress,
        destinationAddress,
        customerTripDurationMinutes,
        status,
        currency,
        depositAmountCents,
        depositPaidAt: null,
        finalAmountCents,
        scheduledAt: new Date(scheduledAt),
        completedAt: null,
        cancelledAt: null,
        invoicedAt: null,
        invoiceAmountCents: null,
        paidAt: null,
        paidAmountCents: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      fakeState.bookings.push(row);
      return [row];
    },
  };

  return {
    bookings: bookingsTable,
    assertOne: (rows: unknown[]) => {
      if (rows.length === 0) throw new Error("Expected exactly one row, got none");
      return rows[0];
    },
    getDb: () => db,
  };
});

const {
  ensureBookingForApprovedTransferRequest,
  ensureBookingFromCalendarEvent,
  getBookingByCalendarEventId,
  cancelBookingByCalendarEventId,
  updateBooking,
  confirmBookingDeposit,
  attachCalendarEventToBooking,
} = await import("./service");

function inputFor(overrides: Partial<EnsureBookingSnapshotInput> = {}): EnsureBookingSnapshotInput {
  return {
    transferRequestId: "request-1",
    clientId: "client-1",
    pickup: "Sondrio",
    destination: "Malpensa",
    pickupAddress: null,
    destinationAddress: null,
    customerTripDurationMinutes: 45,
    scheduledAt: new Date("2026-09-15T08:00:00.000Z"),
    finalAmountCents: 25000,
    currency: "EUR",
    depositAmountCents: 13000,
    ...overrides,
  };
}

beforeEach(() => {
  fakeState.bookings = [];
  fakeState.nextId = 1;
  jobsMock.emitDomainEvent.mockClear();
});

describe("ensureBookingForApprovedTransferRequest", () => {
  it("creates a booking with every field mapped from the input, quoteId null, waiting for the deposit", async () => {
    const booking = await ensureBookingForApprovedTransferRequest("tenant-1", inputFor());

    expect(booking.transferRequestId).toBe("request-1");
    expect(booking.tenantId).toBe("tenant-1");
    expect(booking.clientId).toBe("client-1");
    expect(booking.pickup).toBe("Sondrio");
    expect(booking.destination).toBe("Malpensa");
    expect(booking.customerTripDurationMinutes).toBe(45);
    expect(booking.finalAmountCents).toBe(25000);
    expect(booking.currency).toBe("EUR");
    expect(booking.quoteId).toBeNull();
    expect(booking.status).toBe("pending_deposit");
    expect(booking.depositAmountCents).toBe(13000);
    expect(booking.depositPaidAt).toBeNull();
  });

  it("is idempotent — a second call with the same transferRequestId returns the existing booking, never a duplicate", async () => {
    const first = await ensureBookingForApprovedTransferRequest("tenant-1", inputFor());
    const second = await ensureBookingForApprovedTransferRequest("tenant-1", inputFor({ finalAmountCents: 99999 }));

    expect(fakeState.bookings).toHaveLength(1);
    expect(second.id).toBe(first.id);
    // The conflicting second call's input is discarded, not applied on top
    // of the existing row — ensureBookingForApprovedTransferRequest never
    // updates an existing booking.
    expect(second.finalAmountCents).toBe(25000);
  });

  it("two different transferRequestIds create two separate bookings", async () => {
    await ensureBookingForApprovedTransferRequest("tenant-1", inputFor({ transferRequestId: "request-1" }));
    await ensureBookingForApprovedTransferRequest("tenant-1", inputFor({ transferRequestId: "request-2" }));

    expect(fakeState.bookings).toHaveLength(2);
  });
});

function calendarInputFor(
  overrides: Partial<EnsureBookingFromCalendarEventInput> = {},
): EnsureBookingFromCalendarEventInput {
  return {
    calendarEventId: "gcal-event-1",
    clientId: "client-1",
    pickup: "Milano",
    destination: "Tirano",
    scheduledAt: new Date("2026-09-20T09:00:00.000Z"),
    finalAmountCents: 39000,
    currency: "EUR",
    ...overrides,
  };
}

describe("ensureBookingFromCalendarEvent", () => {
  // TEST 3 — nuovo evento -> crea booking, stato confirmed.
  it("creates a new booking with status confirmed on first sync", async () => {
    const booking = await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor());

    expect(booking.calendarEventId).toBe("gcal-event-1");
    expect(booking.status).toBe("confirmed");
    expect(booking.pickup).toBe("Milano");
    expect(booking.destination).toBe("Tirano");
    expect(booking.finalAmountCents).toBe(39000);
  });

  // TEST 5 — stesso evento sincronizzato 10 volte -> 1 booking.
  it("is idempotent — the same calendarEventId synced 10 times produces exactly one booking", async () => {
    for (let i = 0; i < 10; i++) {
      await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor());
    }

    expect(fakeState.bookings).toHaveLength(1);
  });

  // TEST 6 — modifica evento -> stesso booking aggiornato, non un secondo.
  it("updates the same booking's descriptive fields on a re-sync, never creates a second row", async () => {
    const first = await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor());
    const updated = await ensureBookingFromCalendarEvent(
      "tenant-1",
      calendarInputFor({ destination: "Tirano centro", finalAmountCents: 42000 }),
    );

    expect(fakeState.bookings).toHaveLength(1);
    expect(updated.id).toBe(first.id);
    expect(updated.destination).toBe("Tirano centro");
    expect(updated.finalAmountCents).toBe(42000);
  });

  it("never changes clientId or status on a re-sync, even if the input tries to", async () => {
    await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor({ clientId: "client-1" }));
    const updated = await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor({ clientId: "client-2" }));

    expect(updated.clientId).toBe("client-1");
    expect(updated.status).toBe("confirmed");
  });

  // TEST 9 — servizio senza prezzo affidabile -> nessuna revenue inventata.
  it("creates a booking with finalAmountCents null when the event carried no reliable price", async () => {
    const booking = await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor({ finalAmountCents: null }));

    expect(booking.finalAmountCents).toBeNull();
  });

  it("never revives an already-cancelled booking's data on a re-sync", async () => {
    await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor());
    await cancelBookingByCalendarEventId("tenant-1", "gcal-event-1");

    const reSynced = await ensureBookingFromCalendarEvent(
      "tenant-1",
      calendarInputFor({ destination: "Somewhere else" }),
    );

    expect(reSynced.status).toBe("cancelled");
    expect(reSynced.destination).toBe("Tirano");
  });
});

describe("getBookingByCalendarEventId", () => {
  it("finds the exact booking by calendarEventId, even with others present", async () => {
    await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor({ calendarEventId: "gcal-1" }));
    await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor({ calendarEventId: "gcal-2" }));

    const found = await getBookingByCalendarEventId("tenant-1", "gcal-2");
    expect(found?.calendarEventId).toBe("gcal-2");
  });

  it("returns null when no booking matches", async () => {
    const found = await getBookingByCalendarEventId("tenant-1", "does-not-exist");
    expect(found).toBeNull();
  });
});

describe("cancelBookingByCalendarEventId", () => {
  // TEST 7 — cancellazione evento -> booking cancelled, mai cancellato fisicamente.
  it("moves the booking to status cancelled and sets cancelledAt, keeping the row", async () => {
    await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor());

    const cancelled = await cancelBookingByCalendarEventId("tenant-1", "gcal-event-1");

    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancelledAt).not.toBeNull();
    expect(fakeState.bookings).toHaveLength(1);
  });

  it("is idempotent — cancelling an already-cancelled booking twice is a safe no-op", async () => {
    await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor());
    await cancelBookingByCalendarEventId("tenant-1", "gcal-event-1");

    const second = await cancelBookingByCalendarEventId("tenant-1", "gcal-event-1");

    expect(second).toBeNull();
  });

  it("returns null when no booking exists for the given calendarEventId", async () => {
    const result = await cancelBookingByCalendarEventId("tenant-1", "does-not-exist");
    expect(result).toBeNull();
  });
});

describe("confirmBookingDeposit", () => {
  beforeEach(() => advanceDealStatus.mockClear());

  it("moves pending_deposit -> confirmed, stamps depositPaidAt and confirms the deal", async () => {
    const booking = await ensureBookingForApprovedTransferRequest("tenant-1", inputFor({ dealId: "deal-1" }));

    const result = await confirmBookingDeposit("tenant-1", booking.id);

    expect(result?.changed).toBe(true);
    expect(result?.booking.status).toBe("confirmed");
    expect(result?.booking.depositPaidAt).toBeInstanceOf(Date);
    expect(result?.booking.depositAmountCents).toBe(13000);
    expect(advanceDealStatus).toHaveBeenCalledWith("tenant-1", "deal-1", "confirmed");
  });

  it("records a different received amount when given", async () => {
    const booking = await ensureBookingForApprovedTransferRequest("tenant-1", inputFor());
    const result = await confirmBookingDeposit("tenant-1", booking.id, 10000);
    expect(result?.booking.depositAmountCents).toBe(10000);
  });

  it("a second call changes nothing (double tap)", async () => {
    const booking = await ensureBookingForApprovedTransferRequest("tenant-1", inputFor({ dealId: "deal-1" }));
    await confirmBookingDeposit("tenant-1", booking.id);
    advanceDealStatus.mockClear();

    const second = await confirmBookingDeposit("tenant-1", booking.id);

    expect(second?.changed).toBe(false);
    expect(second?.booking.status).toBe("confirmed");
    expect(advanceDealStatus).not.toHaveBeenCalled();
  });

  it("never confirms a cancelled booking", async () => {
    const booking = await ensureBookingForApprovedTransferRequest("tenant-1", inputFor());
    booking.status = "cancelled";

    const result = await confirmBookingDeposit("tenant-1", booking.id);

    expect(result?.changed).toBe(false);
    expect(result?.booking.status).toBe("cancelled");
  });

  it("returns null for an unknown booking", async () => {
    expect(await confirmBookingDeposit("tenant-1", "booking-nope")).toBeNull();
  });
});

// BOS Agent V2 booking lifecycle wiring — booking.confirmed/booking.completed
// were already in the event catalog (packages/jobs/src/events.ts) with no
// real producer; this is the first one. Only tenantId + bookingId in the
// payload (matches the catalog's schema exactly) — no pickup/destination/
// price or other booking detail, since the BOS Agent's context-builder.ts
// doesn't resolve a "booking" entity from the event anyway (see
// inngest-functions.ts's own comment) and there's no reason to carry data
// nothing downstream reads.
describe("booking.confirmed domain event", () => {
  it("ensureBookingForApprovedTransferRequest never emits booking.confirmed: the booking waits for its deposit", async () => {
    await ensureBookingForApprovedTransferRequest("tenant-1", inputFor());
    await ensureBookingForApprovedTransferRequest("tenant-1", inputFor({ finalAmountCents: 99999 }));

    expect(jobsMock.emitDomainEvent).not.toHaveBeenCalledWith(jobsMock.inngest, "booking.confirmed", expect.anything());
  });

  it("confirmBookingDeposit emits booking.confirmed exactly once, on the real transition", async () => {
    const booking = await ensureBookingForApprovedTransferRequest("tenant-1", inputFor());

    await confirmBookingDeposit("tenant-1", booking.id);
    await confirmBookingDeposit("tenant-1", booking.id);

    const confirmations = jobsMock.emitDomainEvent.mock.calls.filter((call) => call[1] === "booking.confirmed");
    expect(confirmations).toEqual([[jobsMock.inngest, "booking.confirmed", { tenantId: "tenant-1", bookingId: booking.id }]]);
  });

  it("ensureBookingFromCalendarEvent emits booking.confirmed on first sync", async () => {
    const booking = await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor());

    expect(jobsMock.emitDomainEvent).toHaveBeenCalledWith(jobsMock.inngest, "booking.confirmed", {
      tenantId: "tenant-1",
      bookingId: booking.id,
    });
  });

  it("ensureBookingFromCalendarEvent never re-emits on a re-sync of the same calendar event", async () => {
    await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor());
    jobsMock.emitDomainEvent.mockClear();

    await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor({ destination: "Tirano centro" }));

    expect(jobsMock.emitDomainEvent).not.toHaveBeenCalledWith(jobsMock.inngest, "booking.confirmed", expect.anything());
  });

  it("never re-emits when a re-sync hits the already-cancelled WHERE guard (a real no-op, not a fresh confirmation)", async () => {
    await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor());
    await cancelBookingByCalendarEventId("tenant-1", "gcal-event-1");
    jobsMock.emitDomainEvent.mockClear();

    await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor({ destination: "Somewhere else" }));

    expect(jobsMock.emitDomainEvent).not.toHaveBeenCalledWith(jobsMock.inngest, "booking.confirmed", expect.anything());
  });

  it("keeps tenant isolation — the emitted payload's tenantId is exactly the call's tenantId", async () => {
    const booking = await ensureBookingForApprovedTransferRequest("tenant-42", inputFor({ transferRequestId: "request-99" }));
    await confirmBookingDeposit("tenant-42", booking.id);

    expect(jobsMock.emitDomainEvent).toHaveBeenCalledWith(jobsMock.inngest, "booking.confirmed", {
      tenantId: "tenant-42",
      bookingId: booking.id,
    });
  });
});

describe("booking.completed domain event", () => {
  it("updateBooking emits booking.completed with exactly tenantId and bookingId, on the first transition to status completed", async () => {
    const created = await ensureBookingForApprovedTransferRequest("tenant-1", inputFor());
    jobsMock.emitDomainEvent.mockClear();

    const completed = await updateBooking("tenant-1", { id: created.id as string, status: "completed" });

    expect(jobsMock.emitDomainEvent).toHaveBeenCalledWith(jobsMock.inngest, "booking.completed", {
      tenantId: "tenant-1",
      bookingId: created.id,
    });
    expect(completed?.completedAt).not.toBeNull();
  });

  it("never re-emits booking.completed on a later, unrelated patch to an already-completed booking", async () => {
    const created = await ensureBookingForApprovedTransferRequest("tenant-1", inputFor());
    await updateBooking("tenant-1", { id: created.id as string, status: "completed" });
    jobsMock.emitDomainEvent.mockClear();

    // Recording the final payment days later must never look like a fresh
    // completion just because the patch happens to repeat status:"completed"
    // or touches an already-completed row.
    await updateBooking("tenant-1", { id: created.id as string, status: "completed", paidAmountCents: 25000 });

    expect(jobsMock.emitDomainEvent).not.toHaveBeenCalledWith(jobsMock.inngest, "booking.completed", expect.anything());
  });

  it("never emits booking.completed for a patch that doesn't touch status at all", async () => {
    const created = await ensureBookingForApprovedTransferRequest("tenant-1", inputFor());
    jobsMock.emitDomainEvent.mockClear();

    await updateBooking("tenant-1", { id: created.id as string, depositAmountCents: 5000 });

    expect(jobsMock.emitDomainEvent).not.toHaveBeenCalled();
  });

  it("never emits for a nonexistent booking id", async () => {
    await updateBooking("tenant-1", { id: "booking-does-not-exist", status: "completed" });

    expect(jobsMock.emitDomainEvent).not.toHaveBeenCalled();
  });

  it("keeps tenant isolation on booking.completed's payload", async () => {
    const created = await ensureBookingForApprovedTransferRequest("tenant-77", inputFor({ transferRequestId: "request-77" }));
    jobsMock.emitDomainEvent.mockClear();

    await updateBooking("tenant-77", { id: created.id as string, status: "completed" });

    expect(jobsMock.emitDomainEvent).toHaveBeenCalledWith(jobsMock.inngest, "booking.completed", {
      tenantId: "tenant-77",
      bookingId: created.id,
    });
  });
});

describe("booking.cancelled domain event (founder decision 2026-09-25: Calendar event marked ANNULLATO)", () => {
  it("updateBooking emits booking.cancelled on the first transition to cancelled", async () => {
    const created = await ensureBookingForApprovedTransferRequest("tenant-1", inputFor());
    jobsMock.emitDomainEvent.mockClear();

    const cancelled = await updateBooking("tenant-1", { id: created.id as string, status: "cancelled" });

    expect(jobsMock.emitDomainEvent).toHaveBeenCalledWith(jobsMock.inngest, "booking.cancelled", {
      tenantId: "tenant-1",
      bookingId: created.id,
    });
    expect(cancelled?.cancelledAt).not.toBeNull();
  });

  it("never re-emits booking.cancelled for an already-cancelled booking", async () => {
    const created = await ensureBookingForApprovedTransferRequest("tenant-1", inputFor());
    await updateBooking("tenant-1", { id: created.id as string, status: "cancelled" });
    jobsMock.emitDomainEvent.mockClear();

    await updateBooking("tenant-1", { id: created.id as string, status: "cancelled" });

    expect(jobsMock.emitDomainEvent).not.toHaveBeenCalledWith(jobsMock.inngest, "booking.cancelled", expect.anything());
  });

  it("a cancellation coming from Google Calendar does not emit booking.cancelled (the event is already cancelled there)", async () => {
    await ensureBookingFromCalendarEvent("tenant-1", calendarInputFor({ calendarEventId: "google-evt-9" }));
    jobsMock.emitDomainEvent.mockClear();

    await cancelBookingByCalendarEventId("tenant-1", "google-evt-9");

    expect(jobsMock.emitDomainEvent).not.toHaveBeenCalledWith(jobsMock.inngest, "booking.cancelled", expect.anything());
  });
});

describe("attachCalendarEventToBooking", () => {
  it("stores the id of the event BOS created on the booking", async () => {
    const created = await ensureBookingForApprovedTransferRequest("tenant-1", inputFor());

    const attached = await attachCalendarEventToBooking("tenant-1", created.id as string, "bos0123");

    expect(attached).toBe(true);
    expect((await getBookingByCalendarEventId("tenant-1", "bos0123"))?.id).toBe(created.id);
  });

  it("returns false for an unknown booking", async () => {
    expect(await attachCalendarEventToBooking("tenant-1", "booking-does-not-exist", "bos0123")).toBe(false);
  });
});
