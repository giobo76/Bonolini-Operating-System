"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerCaller, type DecisionResult } from "@bos/core";

// "280", "280,50", "280.50", "280 €" -> cents. Anything else -> null.
function parseEuros(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d{1,5})(?:[.,](\d{1,2}))?\s*€?\s*$/.exec(value);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + (match[2] ? Number(match[2].padEnd(2, "0")) : 0);
  return cents > 0 ? cents : null;
}

function backTo(id: string, result: Pick<DecisionResult, "outcome" | "message">): never {
  revalidatePath("/preventivi");
  revalidatePath(`/preventivi/${id}`);
  const params = new URLSearchParams({ esito: result.message, tipo: result.outcome });
  redirect(`/preventivi/${id}?${params.toString()}`);
}

export async function approveAction(formData: FormData) {
  const id = String(formData.get("id"));
  const caller = await createServerCaller();
  backTo(id, await caller.quoteApproval.approve({ id }));
}

export async function rejectAction(formData: FormData) {
  const id = String(formData.get("id"));
  const caller = await createServerCaller();
  backTo(id, await caller.quoteApproval.reject({ id }));
}

export async function reviseAction(formData: FormData) {
  const id = String(formData.get("id"));
  const amountCents = parseEuros(formData.get("prezzo"));
  if (amountCents === null) {
    backTo(id, {
      outcome: "refused",
      message: "Prezzo non valido: scrivi un importo in euro maggiore di zero, es. 280 oppure 280,50.",
    });
  }
  // Empty = 50% of the new price, nearest 10 €.
  const depositRaw = formData.get("acconto");
  const depositCents = typeof depositRaw === "string" && depositRaw.trim() !== "" ? parseEuros(depositRaw) : undefined;
  if (depositCents === null) {
    backTo(id, { outcome: "refused", message: "Acconto non valido: scrivi un importo in euro, es. 100, o lascia vuoto." });
  }
  const caller = await createServerCaller();
  const result = await caller.quoteApproval.revise({ id, amountCents, depositCents });
  backTo(result.newRoundId ?? id, result);
}

// Only back to our own pages: never an arbitrary URL from the form.
function safeBackPath(value: FormDataEntryValue | null): string {
  if (typeof value === "string" && /^\/(preventivi|customers\/[0-9a-f-]{36})$/.test(value)) return value;
  return "/preventivi";
}

// "Acconto ricevuto": confirms the booking and sends the customer the
// automatic confirmation (same as the WhatsApp button).
export async function confirmDepositAction(formData: FormData) {
  const bookingId = String(formData.get("bookingId"));
  const back = safeBackPath(formData.get("back"));
  const receivedRaw = formData.get("importo");
  const receivedAmountCents =
    typeof receivedRaw === "string" && receivedRaw.trim() !== "" ? parseEuros(receivedRaw) ?? undefined : undefined;

  const caller = await createServerCaller();
  const result = await caller.quoteApproval.confirmDeposit({ bookingId, receivedAmountCents });

  revalidatePath("/preventivi");
  revalidatePath(back);
  const params = new URLSearchParams({ esito: result.message, tipo: result.outcome });
  redirect(`${back}?${params.toString()}`);
}

// "Confermato dal cliente" (italian customers, no deposit): confirms the
// booking and sends the customer the automatic confirmation.
export async function confirmCustomerAction(formData: FormData) {
  const bookingId = String(formData.get("bookingId"));
  const back = safeBackPath(formData.get("back"));

  const caller = await createServerCaller();
  const result = await caller.quoteApproval.confirmCustomer({ bookingId });

  revalidatePath("/preventivi");
  revalidatePath(back);
  const params = new URLSearchParams({ esito: result.message, tipo: result.outcome });
  redirect(`${back}?${params.toString()}`);
}

// "Prezzo da inserire" -> Crea preventivo: opens the new PREVENTIVO PRONTO
// page (Approva / Modifica / Rifiuta); on refusal back to the list.
export async function enterManualPriceAction(formData: FormData) {
  const id = String(formData.get("id"));
  const amountCents = parseEuros(formData.get("prezzo"));
  const back = (result: Pick<DecisionResult, "outcome" | "message">): never => {
    revalidatePath("/preventivi");
    const params = new URLSearchParams({ esito: result.message, tipo: result.outcome });
    redirect(`/preventivi?${params.toString()}`);
  };
  if (amountCents === null) {
    return back({ outcome: "refused", message: "Prezzo non valido: scrivi un importo in euro maggiore di zero, es. 280 oppure 280,50." });
  }
  // Empty = 50% of the price, nearest 10 €.
  const depositRaw = formData.get("acconto");
  const depositCents = typeof depositRaw === "string" && depositRaw.trim() !== "" ? parseEuros(depositRaw) : undefined;
  if (depositCents === null) {
    return back({ outcome: "refused", message: "Acconto non valido: scrivi un importo in euro, es. 100, o lascia vuoto." });
  }
  const caller = await createServerCaller();
  const result = await caller.quoteApproval.enterManualPrice({ id, amountCents, depositCents });
  if (result.newRoundId) backTo(result.newRoundId, result);
  back(result);
}
