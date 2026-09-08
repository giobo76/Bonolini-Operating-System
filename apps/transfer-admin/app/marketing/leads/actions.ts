"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { linkLeadToClientSchema, createServerCaller } from "@bos/core";

// The only write path in this feature: links exactly the (marketingLeadId,
// clientId) pair a staff member explicitly confirmed by clicking "Link this
// lead to this client" on a specific, real client returned from a real
// search (see page.tsx) — never an automatic match by name/phone/email.
// The tRPC procedure itself (marketing.linkLeadToClient, adminProcedure)
// re-derives tenantId from the session and re-validates both ids belong to
// it — this action never trusts the form beyond parsing it.
export async function linkLeadToClientAction(formData: FormData) {
  const parsed = linkLeadToClientSchema.safeParse({
    marketingLeadId: formData.get("marketingLeadId") || undefined,
    clientId: formData.get("clientId") || undefined,
  });

  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(" ");
    redirect(`/marketing/leads?error=${encodeURIComponent(message)}`);
  }

  const caller = await createServerCaller();
  await caller.marketing.linkLeadToClient(parsed.data);

  revalidatePath("/marketing/leads");
  redirect("/marketing/leads?linked=1");
}
