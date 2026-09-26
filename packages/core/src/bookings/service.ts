import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { getDb, bookings, assertOne, type Booking } from "@bos/db";
import { inngest, emitDomainEvent } from "@bos/jobs";
import { advanceDealStatus } from "../deals";
import type {
  CreateBookingInput,
  UpdateBookingInput,
  EnsureBookingSnapshotInput,
  EnsureBookingFromCalendarEventInput,
} from "./schema";

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

// booking.completed: this is a generic, multi-purpose patch function (also
// used to record a deposit, an invoice, a payment, or a cancellation) — it
// must never emit just because `status: "completed"` appears in a patch
// that's actually a no-op repeat of an already-completed booking (e.g. a
// later call recording the final payment on a booking completed days ago
// would otherwise incorrectly re-fire the event). The pre-fetch below is
// only done on the rare "this patch touches status" path, and the
// genuinely-new-transition check compares against that snapshot, not
// against the patch itself — same idempotency-by-provably-fresh-branch
// discipline as transfer-requests/service.ts's acceptTransferRequest.
export async function updateBooking(tenantId: string, input: UpdateBookingInput) {
  const db = getDb();
  const { id, ...patch } = input;
  const now = new Date();

  const isCompleting = patch.status === "completed";
  const isCancelling = patch.status === "cancelled";
  // Captured as a plain boolean, not held as a reference to the fetched
  // row: the row object returned by the update below is the same booking
  // (same real DB row, same id), and comparing against a still-referenced
  // "previous" object after mutating it is a real footgun — decide now,
  // from the pre-update snapshot, whether this is a genuinely new
  // transition.
  const wasAlreadyCompleted = isCompleting ? (await getBooking(tenantId, id))?.status === "completed" : false;
  const wasAlreadyCancelled = isCancelling ? (await getBooking(tenantId, id))?.status === "cancelled" : false;

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

  if (row && isCompleting && !wasAlreadyCompleted) {
    void emitDomainEvent(inngest, "booking.completed", { tenantId, bookingId: row.id });
  }
  if (row && isCancelling && !wasAlreadyCancelled) {
    void emitDomainEvent(inngest, "booking.cancelled", { tenantId, bookingId: row.id });
  }

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
      tenant_id, client_id, transfer_request_id, deal_id, pickup, destination,
      pickup_address, destination_address, customer_trip_duration_minutes,
      scheduled_at, final_amount_cents, currency, status, deposit_amount_cents
    ) values (
      ${tenantId}, ${input.clientId}, ${input.transferRequestId}, ${input.dealId ?? null}, ${input.pickup}, ${input.destination},
      ${input.pickupAddress}, ${input.destinationAddress}, ${input.customerTripDurationMinutes},
      ${input.scheduledAt.toISOString()}, ${input.finalAmountCents}, ${input.currency},
      ${input.depositAmountCents === null ? "pending_confirmation" : "pending_deposit"}, ${input.depositAmountCents}
    )
    on conflict (transfer_request_id) do nothing
    returning *
  `);

  if (insertedRows.length > 0) {
    // No booking.confirmed here: an approved quote is not a booking until
    // the deposit arrives or the customer confirms — see
    // confirmBookingDeposit / confirmBookingByCustomer.
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

export async function getBookingByTransferRequestId(tenantId: string, transferRequestId: string): Promise<Booking | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.tenantId, tenantId), eq(bookings.transferRequestId, transferRequestId)));
  return row ?? null;
}

export async function listPendingDepositBookings(tenantId: string): Promise<Booking[]> {
  const db = getDb();
  return db
    .select()
    .from(bookings)
    .where(and(eq(bookings.tenantId, tenantId), eq(bookings.status, "pending_deposit")))
    .orderBy(bookings.createdAt);
}

export async function listPendingConfirmationBookings(tenantId: string): Promise<Booking[]> {
  const db = getDb();
  return db
    .select()
    .from(bookings)
    .where(and(eq(bookings.tenantId, tenantId), eq(bookings.status, "pending_confirmation")))
    .orderBy(bookings.createdAt);
}

export interface ConfirmBookingDepositResult {
  booking: Booking;
  // false when the booking was not waiting for a deposit (already
  // confirmed, cancelled, completed): nothing was changed.
  changed: boolean;
}

// pending_deposit -> confirmed, the one moment an approved quote becomes a
// real booking. Conditional UPDATE: of two concurrent calls (a double tap,
// the WhatsApp button and the admin panel at once) exactly one changes the
// row and emits booking.confirmed; the other gets changed:false.
export async function confirmBookingDeposit(
  tenantId: string,
  id: string,
  receivedAmountCents?: number,
): Promise<ConfirmBookingDepositResult | null> {
  const db = getDb();
  const now = new Date();
  const [row] = await db
    .update(bookings)
    .set({
      status: "confirmed",
      depositPaidAt: now,
      ...(receivedAmountCents !== undefined ? { depositAmountCents: receivedAmountCents } : {}),
      updatedAt: now,
    })
    .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, id), eq(bookings.status, "pending_deposit")))
    .returning();

  if (!row) {
    const current = await getBooking(tenantId, id);
    return current ? { booking: current, changed: false } : null;
  }

  return afterConfirmation(tenantId, row);
}

// pending_confirmation -> confirmed: the italian customer (never a deposit)
// said yes, recorded by the founder's "Confermato dal cliente". Same
// conditional UPDATE and effects as confirmBookingDeposit.
export async function confirmBookingByCustomer(
  tenantId: string,
  id: string,
): Promise<ConfirmBookingDepositResult | null> {
  const db = getDb();
  const [row] = await db
    .update(bookings)
    .set({ status: "confirmed", updatedAt: new Date() })
    .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, id), eq(bookings.status, "pending_confirmation")))
    .returning();

  if (!row) {
    const current = await getBooking(tenantId, id);
    return current ? { booking: current, changed: false } : null;
  }
  return afterConfirmation(tenantId, row);
}

async function afterConfirmation(tenantId: string, row: Booking): Promise<ConfirmBookingDepositResult> {
  if (row.dealId) {
    await advanceDealStatus(tenantId, row.dealId, "confirmed");
  }
  void emitDomainEvent(inngest, "booking.confirmed", { tenantId, bookingId: row.id });
  return { booking: row, changed: true };
}

// ── Calendar Sync (Google Calendar event -> booking) ──────────────────────
// Called only from packages/core/src/calendar's sync orchestrator, after
// that module has already resolved the client (via clients'
// findOrCreateClientByPhone) and parsed whatever the event reliably
// carries — this function never calls the Google Calendar API and never
// parses event text itself.
//
// Idempotency: bookings.calendar_event_id is unique (migration 0015). Same
// INSERT ... ON CONFLICT technique as ensureBookingForApprovedTransferRequest
// above, but here the conflict path is a real UPDATE, not DO NOTHING — a
// re-synced event (edited on Google's side, or simply re-delivered by an
// incremental sync) must update the existing booking's fields, never
// create a second row and never silently drop the edit.
//
// Deliberately NEVER updates on conflict: `status` (creation always starts
// 'confirmed' — see column default; every later status change is either
// this same sync's own cancelBookingByCalendarEventId, or an explicit
// separate action never invented here per the founder's "completed is
// never automatic" rule) and `client_id` (re-attributing an existing
// booking to a different client is a materially bigger, riskier change
// than updating its price/route, and isn't asked for here — frozen after
// creation). The `WHERE bookings.status != 'cancelled'` guard on the
// UPDATE additionally means a re-sync of an event whose booking was
// already cancelled is a safe no-op on the row's data, not a silent
// "revival" of a historical, frozen record.
export async function ensureBookingFromCalendarEvent(
  tenantId: string,
  input: EnsureBookingFromCalendarEventInput,
): Promise<Booking> {
  const db = getDb();

  // Resolved before the upsert specifically to tell a genuine first-time
  // creation apart from a re-sync's UPDATE-on-conflict branch — the single
  // INSERT ... ON CONFLICT DO UPDATE query below returns a row on both
  // branches, so `upsertedRows.length > 0` alone can't make that
  // distinction the way insertNewTransferRequest's DO NOTHING can.
  const existingBeforeUpsert = await getBookingByCalendarEventId(tenantId, input.calendarEventId);

  const upsertedRows = await db.execute<Booking>(sql`
    insert into bookings (
      tenant_id, client_id, calendar_event_id, pickup, destination,
      scheduled_at, final_amount_cents, currency
    ) values (
      ${tenantId}, ${input.clientId}, ${input.calendarEventId}, ${input.pickup}, ${input.destination},
      ${input.scheduledAt?.toISOString() ?? null}, ${input.finalAmountCents}, ${input.currency}
    )
    on conflict (calendar_event_id) do update set
      pickup = excluded.pickup,
      destination = excluded.destination,
      scheduled_at = excluded.scheduled_at,
      final_amount_cents = excluded.final_amount_cents,
      currency = excluded.currency,
      updated_at = now()
    where bookings.status != 'cancelled'
    returning *
  `);

  if (upsertedRows.length > 0) {
    const result = assertOne(upsertedRows, "ensureBookingFromCalendarEvent");
    // Only when the pre-upsert check found nothing — a genuinely new
    // booking just landed at its 'confirmed' column default. A re-sync
    // that hit the DO UPDATE branch (existingBeforeUpsert was already a
    // row) never re-emits.
    if (!existingBeforeUpsert) {
      void emitDomainEvent(inngest, "booking.confirmed", { tenantId, bookingId: result.id });
    }
    return result;
  }

  // Either the WHERE guard suppressed the update (booking already
  // cancelled — a safe, expected no-op) or a genuine race with another
  // process. Either way, read back the current row rather than treating
  // this as an error.
  const [existing] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.tenantId, tenantId), eq(bookings.calendarEventId, input.calendarEventId)));

  if (!existing) {
    throw new Error(
      `ensureBookingFromCalendarEvent: insert conflicted but no existing booking was found for calendar event ${input.calendarEventId}`,
    );
  }
  return existing;
}

export async function getBookingByCalendarEventId(
  tenantId: string,
  calendarEventId: string,
): Promise<Booking | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.tenantId, tenantId), eq(bookings.calendarEventId, calendarEventId)));
  return row ?? null;
}

// Bookings that keep the founder busy (waiting for a deposit, waiting for
// the customer's confirmation, or confirmed) with a pickup time in
// [from, to] — for the overlap check (founder decision 2026-09-26).
export async function listActiveBookingsBetween(tenantId: string, from: Date, to: Date): Promise<Booking[]> {
  const db = getDb();
  return db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        inArray(bookings.status, ["pending_deposit", "pending_confirmation", "confirmed"]),
        gte(bookings.scheduledAt, from),
        lte(bookings.scheduledAt, to),
      ),
    )
    .orderBy(bookings.scheduledAt);
}

// Stores the busy window the overlap check computed (availability's
// StoredBusyWindow), only when the booking has none yet: a retried Approva
// never overwrites it.
export async function setBookingBusyWindow(tenantId: string, bookingId: string, busyWindow: unknown): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .update(bookings)
    .set({ busyWindow, updatedAt: new Date() })
    .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, bookingId), isNull(bookings.busyWindow)))
    .returning({ id: bookings.id });
  return rows.length > 0;
}

// Links a booking to the Google Calendar event BOS created for it. Only
// when the booking has no event yet: a retried call is a no-op, and a
// booking that came from Calendar keeps its own event id.
export async function attachCalendarEventToBooking(
  tenantId: string,
  bookingId: string,
  calendarEventId: string,
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .update(bookings)
    .set({ calendarEventId, updatedAt: new Date() })
    .where(and(eq(bookings.tenantId, tenantId), eq(bookings.id, bookingId), isNull(bookings.calendarEventId)))
    .returning({ id: bookings.id });
  return rows.length > 0;
}

// A cancelled Google Calendar event never deletes the booking — it moves
// the existing state machine to 'cancelled', preserving history (per the
// founder's explicit rule: a cancelled real conversion must stay in the
// historical record, just excluded from active real-conversion/revenue
// counts — see business-kpis.ts's getRealConversionSummary, unchanged by
// this milestone). Idempotent: the WHERE guard means calling this twice
// for the same already-cancelled event is a safe no-op (returns null the
// second time, same as "no booking found for this event" — the caller
// doesn't need to distinguish the two, both mean "nothing left to do").
export async function cancelBookingByCalendarEventId(
  tenantId: string,
  calendarEventId: string,
): Promise<Booking | null> {
  const db = getDb();
  const [row] = await db
    .update(bookings)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        eq(bookings.calendarEventId, calendarEventId),
        sql`${bookings.status} != 'cancelled'`,
      ),
    )
    .returning();
  return row ?? null;
}
