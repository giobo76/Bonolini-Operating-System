"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerCaller } from "@bos/core";

function parseEurosToCents(value: FormDataEntryValue | null): number | undefined {
  if (!value || typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) return undefined;
  return Math.round(parsed * 100);
}

export async function createQuoteAction(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const caller = await createServerCaller();

  await caller.quotes.create({
    clientId,
    amountCents: parseEurosToCents(formData.get("amount")),
    notes: (formData.get("notes") as string) || undefined,
    status: "sent",
  });

  revalidatePath(`/customers/${clientId}`);
  redirect(`/customers/${clientId}`);
}

export async function updateQuoteStatusAction(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const id = String(formData.get("id"));
  const status = formData.get("status") as "accepted" | "declined" | "expired";

  const caller = await createServerCaller();
  await caller.quotes.updateStatus({ id, status });

  revalidatePath(`/customers/${clientId}`);
  redirect(`/customers/${clientId}`);
}

export async function createBookingAction(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const quoteId = (formData.get("quoteId") as string) || undefined;
  const scheduledAtRaw = formData.get("scheduledAt") as string;

  const caller = await createServerCaller();
  await caller.bookings.create({
    clientId,
    quoteId: quoteId || undefined,
    finalAmountCents: parseEurosToCents(formData.get("finalAmount")),
    scheduledAt: scheduledAtRaw ? new Date(scheduledAtRaw) : undefined,
  });

  revalidatePath(`/customers/${clientId}`);
  redirect(`/customers/${clientId}`);
}

// One flexible action behind several small forms (record deposit, mark
// completed, cancel, record invoice, record payment) — see
// packages/core/src/bookings/schema.ts's updateBookingSchema and
// service.ts's derived-timestamp logic.
export async function updateBookingAction(formData: FormData) {
  const clientId = String(formData.get("clientId"));
  const id = String(formData.get("id"));

  const caller = await createServerCaller();
  await caller.bookings.update({
    id,
    status: (formData.get("status") as "confirmed" | "completed" | "cancelled" | null) ?? undefined,
    depositAmountCents: parseEurosToCents(formData.get("depositAmount")),
    finalAmountCents: parseEurosToCents(formData.get("finalAmount")),
    invoiceAmountCents: parseEurosToCents(formData.get("invoiceAmount")),
    paidAmountCents: parseEurosToCents(formData.get("paidAmount")),
  });

  revalidatePath(`/customers/${clientId}`);
  redirect(`/customers/${clientId}`);
}
