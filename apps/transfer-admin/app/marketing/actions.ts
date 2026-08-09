"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerCaller } from "@bos/core";

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
