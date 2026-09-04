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

// Every lookup this module does is (tenantId, transferRequestId) or
// (tenantId, calendarEventId) — a booking is only ever sourced from one
// path, never both, so matching either field against the second extracted
// value is unambiguous for these tests.
function findByTenantAndKey(tenantId: unknown, key: unknown): Record<string, unknown> | undefined {
  return fakeState.bookings.find(
    (b) => b.tenantId === tenantId && (b.transferRequestId === key || b.calendarEventId === key),
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
          // Mirrors the real WHERE guard (bookings.status != 'cancelled')
          // that cancelBookingByCalendarEventId's SQL expresses — an
          // already-cancelled booking is never touched again, same
          // idempotency guarantee as the raw-SQL upsert below.
          const applies = target && target.status !== "cancelled";
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
        pickup,
        destination,
        pickupAddress,
        destinationAddress,
        customerTripDurationMinutes,
        scheduledAt,
        finalAmountCents,
        currency,
      ] = params as [string, string, string, string, string, string | null, string | null, number, string, number, string];

      const conflict = fakeState.bookings.some((b) => b.transferRequestId === transferRequestId);
      if (conflict) return [];

      const row: Record<string, unknown> = {
        id: `booking-${fakeState.nextId++}`,
        tenantId,
        clientId,
        transferRequestId,
        calendarEventId: null,
        quoteId: null,
        pickup,
        destination,
        pickupAddress,
        destinationAddress,
        customerTripDurationMinutes,
        status: "confirmed",
        currency,
        depositAmountCents: null,
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
    ...overrides,
  };
}

beforeEach(() => {
  fakeState.bookings = [];
  fakeState.nextId = 1;
});

describe("ensureBookingForApprovedTransferRequest", () => {
  it("creates a booking with every field mapped from the input, plus quoteId null and status confirmed", async () => {
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
    expect(booking.status).toBe("confirmed");
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
