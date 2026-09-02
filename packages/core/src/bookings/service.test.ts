import { StringChunk } from "drizzle-orm";
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { EnsureBookingSnapshotInput } from "./schema";

// @bos/db fully mocked — same convention as
// packages/core/src/transfer-requests/service.test.ts (no test-database
// strategy exists yet). Only what ensureBookingForApprovedTransferRequest
// itself needs: the raw INSERT ... ON CONFLICT DO NOTHING RETURNING * and
// its SELECT fallback.
const { fakeState, bookingsTable } = vi.hoisted(() => {
  return {
    fakeState: { bookings: [] as Array<Record<string, unknown>>, nextId: 1 },
    bookingsTable: { __name: "bookings" },
  };
});

vi.mock("@bos/db", () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(fakeState.bookings),
      }),
    }),
    execute: async (query: { queryChunks: unknown[] }) => {
      const params = query.queryChunks.filter((chunk) => !(chunk instanceof StringChunk));
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

const { ensureBookingForApprovedTransferRequest } = await import("./service");

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
