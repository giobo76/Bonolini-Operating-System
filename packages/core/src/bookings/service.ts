import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, bookings, assertOne, type Booking } from "@bos/db";
import type { CreateBookingInput, UpdateBookingInput, EnsureBookingSnapshotInput } from "./schema";

export async function createBooking(tenantId: string, input: CreateBookingInput) {
  const db = getDb();
  const rows = await db
    .insert(bookings)
    .values({ tenantId, ...input })
    .returning();
  return assertOne(rows, "createBooking");
}

export async function listBookingsForClient(tenantId: string, clientId: string) {
  const db = getDb();
  return db
    .select()
    .from(bookings)
    .where(and(eq(bookings.tenantId, tenantId), eq(bookings.clientId, clientId)))
    .orderBy(desc(bookings.createdAt));
}

export async function getBooking(tenantId: string, id: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, id)));
  return row ?? null;
}

export async function updateBooking(tenantId: string, input: UpdateBookingInput) {
  const db = getDb();
  const { id, ...patch } = input;
  const now = new Date();

  // Recording a milestone amount implies "this just happened now" unless a
  // specific timestamp was already supplied — matches the admin UI, which
  // has one-click "record deposit/invoice/payment" actions that only send
  // the amount, not a timestamp.
  const derived: Partial<typeof patch> = {};
  if (patch.depositAmountCents !== undefined && patch.depositPaidAt === undefined) {
    derived.depositPaidAt = now;
  }
  if (patch.status === "completed" && patch.completedAt === undefined) {
    derived.completedAt = now;
  }
  if (patch.status === "cancelled" && patch.cancelledAt === undefined) {
    derived.cancelledAt = now;
  }
  if (patch.invoiceAmountCents !== undefined && patch.invoicedAt === undefined) {
    derived.invoicedAt = now;
  }
  if (patch.paidAmountCents !== undefined && patch.paidAt === undefined) {
    derived.paidAt = now;
  }

  const [row] = await db
    .update(bookings)
    .set({ ...patch, ...derived, updatedAt: now })
    .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, id)))
    .returning();
  return row ?? null;
}

// ── Booking Snapshot (transfer_request -> booking) ───────────────────────
// Called only from transfer-requests' ACCEPT/MODIFY_PRICE, after that
// module has already resolved every field (customerTripDurationMinutes via
// its own Maps fallback, scheduledAt via its own Europe/Rome conversion —
// this function never calls Maps, never interprets a timezone, never reads
// transfer_requests directly). Deliberately separate from createBooking(),
// which stays the pre-existing admin/manual path and is untouched by this
// milestone — that schema has no route to these fields and is not
// idempotent, unlike this one.
//
// Idempotency: same raw INSERT ... ON CONFLICT DO NOTHING RETURNING * +
// SELECT-fallback pattern as transfer-requests/service.ts's
// insertNewTransferRequest/createOrMergeAsNewRequest, keyed on the new
// bookings_transfer_request_id_key unique constraint (0013 migration) — a
// transfer_request can never produce more than one booking, and a retry
// after a prior failed attempt (e.g. the caller's Maps fallback failed, or
// this insert itself failed) safely converges on the same single row
// instead of creating a duplicate. quote_id and status are left to their
// column defaults (null, 'confirmed') rather than passed explicitly — same
// discipline as insertNewTransferRequest leaning on transfer_requests'
// own status default.
//
// scheduledAt is serialized to an ISO string before entering the raw SQL
// template — never a raw JS Date object (the exact root cause of the
// production Date-serialization bug transfer-requests/service.ts's own
// history comment documents; same discipline applied here).
export async function ensureBookingForApprovedTransferRequest(
  tenantId: string,
  input: EnsureBookingSnapshotInput,
): Promise<Booking> {
  const db = getDb();

  const insertedRows = await db.execute<Booking>(sql`
    insert into bookings (
      tenant_id, client_id, transfer_request_id, pickup, destination,
      pickup_address, destination_address, customer_trip_duration_minutes,
      scheduled_at, final_amount_cents, currency
    ) values (
      ${tenantId}, ${input.clientId}, ${input.transferRequestId}, ${input.pickup}, ${input.destination},
      ${input.pickupAddress}, ${input.destinationAddress}, ${input.customerTripDurationMinutes},
      ${input.scheduledAt.toISOString()}, ${input.finalAmountCents}, ${input.currency}
    )
    on conflict (transfer_request_id) do nothing
    returning *
  `);

  if (insertedRows.length > 0) {
    return assertOne(insertedRows, "ensureBookingForApprovedTransferRequest");
  }

  const [existing] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.tenantId, tenantId), eq(bookings.transferRequestId, input.transferRequestId)));

  if (!existing) {
    // Unreachable in practice: a conflict on bookings_transfer_request_id_key
    // means a booking for this transfer_request_id already exists — guarded
    // rather than silently swallowed, same discipline as
    // createOrMergeAsNewRequest's equivalent branch.
    throw new Error(
      `ensureBookingForApprovedTransferRequest: insert conflicted but no existing booking was found for transfer_request ${input.transferRequestId}`,
    );
  }
  return existing;
}
