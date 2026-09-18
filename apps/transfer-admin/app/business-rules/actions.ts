"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createServerCaller } from "@bos/core";

const VALID_CATEGORIES = ["pricing", "commercial_relevance", "commission_platform", "seasonality", "priority_weights", "other"] as const;

export async function createRuleAction(formData: FormData) {
  const key = formData.get("key");
  const category = formData.get("category");
  if (typeof key !== "string" || key.trim().length === 0) return;
  if (typeof category !== "string" || !VALID_CATEGORIES.includes(category as (typeof VALID_CATEGORIES)[number])) return;

  const caller = await createServerCaller();
  try {
    await caller.businessRules.create({ key: key.trim(), category: category as (typeof VALID_CATEGORIES)[number] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Create failed.";
    redirect(`/business-rules?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/business-rules");
}

export async function approveVersionAction(formData: FormData) {
  const versionId = formData.get("versionId");
  const ruleId = formData.get("ruleId");
  const reasoning = formData.get("reasoning");
  if (typeof versionId !== "string" || typeof ruleId !== "string") return;

  const caller = await createServerCaller();
  try {
    await caller.businessRules.approve({
      versionId,
      reasoning: typeof reasoning === "string" && reasoning.trim().length > 0 ? reasoning.trim() : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Approval failed.";
    redirect(`/business-rules/${ruleId}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(`/business-rules/${ruleId}`);
  revalidatePath("/business-rules");
}

export async function rejectVersionAction(formData: FormData) {
  const versionId = formData.get("versionId");
  const ruleId = formData.get("ruleId");
  const reasoning = formData.get("reasoning");
  if (typeof versionId !== "string" || typeof ruleId !== "string") return;
  if (typeof reasoning !== "string" || reasoning.trim().length === 0) {
    redirect(`/business-rules/${ruleId}?error=${encodeURIComponent("A reason is required to reject a proposal.")}`);
  }

  const caller = await createServerCaller();
  try {
    await caller.businessRules.reject({ versionId, reasoning: reasoning.trim() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rejection failed.";
    redirect(`/business-rules/${ruleId}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(`/business-rules/${ruleId}`);
  revalidatePath("/business-rules");
}
