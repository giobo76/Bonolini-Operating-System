"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerCaller } from "@bos/core";

export async function approveAction(formData: FormData) {
  const id = formData.get("id");
  if (typeof id !== "string") return;

  const caller = await createServerCaller();
  try {
    await caller.bosAgent.approve({ id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Approval failed.";
    redirect(`/bos-agent?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/bos-agent");
}

export async function rejectAction(formData: FormData) {
  const id = formData.get("id");
  if (typeof id !== "string") return;

  const caller = await createServerCaller();
  await caller.bosAgent.reject({ id });

  revalidatePath("/bos-agent");
}

const VALID_AGENT_NAMES = ["marketing", "social", "operations"] as const;

export async function triggerNowAction(formData: FormData) {
  const agentName = formData.get("agentName");
  if (typeof agentName !== "string" || !VALID_AGENT_NAMES.includes(agentName as (typeof VALID_AGENT_NAMES)[number])) {
    return;
  }

  const caller = await createServerCaller();
  try {
    await caller.bosAgent.triggerNow({ agentName: agentName as (typeof VALID_AGENT_NAMES)[number] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trigger failed.";
    redirect(`/bos-agent?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/bos-agent");
  redirect("/bos-agent?triggered=1");
}
