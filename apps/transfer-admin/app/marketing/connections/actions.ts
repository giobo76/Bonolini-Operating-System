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

// The <select> on the connections page encodes id/name/timezone together
// (id|||name|||timezone) per <option> — every option value comes straight
// from a real listAvailableCalendars() result rendered on that same page
// request, so this can never submit an invented calendar id. A plain
// three-field form (no client JS) can't otherwise keep a hidden
// name/timezone field in sync with a <select>'s chosen option.
export async function selectCalendarAction(formData: FormData) {
  const raw = String(formData.get("calendarChoice") || "");
  const [googleCalendarId, googleCalendarName, timezone] = raw.split("|||");

  if (!googleCalendarId) {
    redirect("/marketing/connections?error=" + encodeURIComponent("No calendar selected"));
  }

  const caller = await createServerCaller();
  await caller.calendar.selectCalendar({
    googleCalendarId,
    googleCalendarName: googleCalendarName || null,
    timezone: timezone || null,
  });

  revalidatePath("/marketing/connections");
  redirect("/marketing/connections");
}

export async function syncCalendarNowAction() {
  const caller = await createServerCaller();
  await caller.calendar.syncNow();

  revalidatePath("/marketing/connections");
  redirect("/marketing/connections");
}
