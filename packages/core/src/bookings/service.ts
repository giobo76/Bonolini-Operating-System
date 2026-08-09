import { and, desc, eq } from "drizzle-orm";
import { getDb, bookings, assertOne } from "@bos/db";
import type { CreateBookingInput, UpdateBookingInput } from "./schema";

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
