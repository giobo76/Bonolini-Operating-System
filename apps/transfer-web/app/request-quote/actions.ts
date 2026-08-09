"use server";

import { redirect } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { leadSubmissionSchema, createServerCaller } from "@bos/core";

export async function submitLeadAction(formData: FormData) {
  const parsed = leadSubmissionSchema.safeParse({
    fullName: formData.get("fullName") || undefined,
    email: formData.get("email") || undefined,
    phone: formData.get("phone") || undefined,
    message: formData.get("message") || undefined,
    utmSource: formData.get("utmSource") || undefined,
    utmMedium: formData.get("utmMedium") || undefined,
    utmCampaign: formData.get("utmCampaign") || undefined,
    utmTerm: formData.get("utmTerm") || undefined,
    utmContent: formData.get("utmContent") || undefined,
    gclid: formData.get("gclid") || undefined,
    landingPage: formData.get("landingPage") || undefined,
  });

  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(" ");
    redirect(`/request-quote?error=${encodeURIComponent(message)}`);
  }

  try {
    const caller = await createServerCaller();
    await caller.clients.submitLead(parsed.data);
  } catch (error) {
    const message = error instanceof TRPCError ? error.message : "Something went wrong.";
    redirect(`/request-quote?error=${encodeURIComponent(message)}`);
  }

  redirect("/request-quote/thank-you");
}
