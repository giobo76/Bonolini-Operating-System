"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addLinkedResourceSchema, createServerCaller } from "@bos/core";

export async function addLinkedResourceAction(formData: FormData) {
  const parsed = addLinkedResourceSchema.safeParse({
    resourceType: formData.get("resourceType") || undefined,
    externalId: formData.get("externalId") || undefined,
    displayName: formData.get("displayName") || undefined,
  });

  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(" ");
    redirect(`/marketing/connections?error=${encodeURIComponent(message)}`);
  }

  const caller = await createServerCaller();
  await caller.marketing.addLinkedResource(parsed.data);

  revalidatePath("/marketing/connections");
  redirect("/marketing/connections");
}

export async function removeLinkedResourceAction(formData: FormData) {
  const id = String(formData.get("id"));
  const caller = await createServerCaller();
  await caller.marketing.removeLinkedResource({ id });

  revalidatePath("/marketing/connections");
  redirect("/marketing/connections");
}

export async function disconnectConnectionAction() {
  const caller = await createServerCaller();
  await caller.marketing.disconnect();

  revalidatePath("/marketing/connections");
  redirect("/marketing/connections");
}
