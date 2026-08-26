"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerCaller } from "@bos/core";

// Findings were previously read-only in the UI — the lifecycle could only
// resolve them automatically (or not at all, for AI commentary with no
// re-checkable signal). This is the operational escape hatch: a human can
// dismiss a finding that isn't actionable, or mark one resolved once fixed
// manually, instead of it sitting open indefinitely.
export async function updateFindingStatusAction(formData: FormData) {
  const id = formData.get("id");
  const status = formData.get("status");
  if (typeof id !== "string" || (status !== "resolved" && status !== "dismissed")) {
    return;
  }

  const caller = await createServerCaller();
  await caller.marketing.updateFindingStatus({ id, status });

  revalidatePath("/marketing");
}

export async function runCheckNowAction() {
  const caller = await createServerCaller();

  try {
    await caller.marketing.runCheckNow();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed.";
    redirect(`/marketing?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/marketing");
  redirect("/marketing?analyzed=1");
}
