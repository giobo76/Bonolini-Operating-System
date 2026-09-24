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
  const caller = await createServerCaller();
  const result = await caller.quoteApproval.revise({ id, amountCents });
  backTo(result.newRoundId ?? id, result);
}
