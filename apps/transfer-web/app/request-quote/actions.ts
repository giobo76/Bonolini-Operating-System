"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { leadSubmissionSchema, createServerCaller, trackLeadConversion, resolveGa4ClientId } from "@bos/core";
import { submitLeadRateLimiter } from "./rate-limit";
import { runSubmitLeadFlow } from "./submit-lead-flow";

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

  const rateLimitKey = formData.get("email")?.toString() || formData.get("phone")?.toString() || "unknown";
  const rateLimitResult = submitLeadRateLimiter(rateLimitKey);
  if (!rateLimitResult.ok) {
    redirect(`/request-quote?error=${encodeURIComponent("Too many requests. Please try again shortly.")}`);
  }

  try {
    const caller = await createServerCaller();
    const cookieStore = await cookies();
    // GA4's own visitor id (see resolveGa4ClientId) — read once, here,
    // before the insert, so the same id is used whether or not the insert
    // itself takes any real time; falls back to a fresh id when this
    // visitor has no _ga cookie (GTM never loaded, consent declined, etc.).
    const gaClientId = resolveGa4ClientId(cookieStore.get("_ga")?.value, randomUUID);

    await runSubmitLeadFlow(parsed.data, {
      submitLead: (input) => caller.clients.submitLead(input),
      trackConversion: () => trackLeadConversion(gaClientId),
    });
  } catch (error) {
    const message = error instanceof TRPCError ? error.message : "Something went wrong.";
    redirect(`/request-quote?error=${encodeURIComponent(message)}`);
  }

  redirect("/request-quote/thank-you");
}
