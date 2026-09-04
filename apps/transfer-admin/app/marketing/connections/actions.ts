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

// Surfaces the sync result on the page via query params (same pattern as
// connected=1/error=... above) — a real gap found during the 2026-09-04
// live diagnosis: "Sync now" always reported lastSyncStatus 'ok' even when
// every event was skipped for missing client data, with nothing on the
// page explaining why. Without this, "0 bookings created" and "a bug"
// look identical from the dashboard.
export async function syncCalendarNowAction() {
  const caller = await createServerCaller();
  const result = await caller.calendar.syncNow();

  revalidatePath("/marketing/connections");
  const params = new URLSearchParams({
    synced: "1",
    eventsSeen: String(result.eventsSeen),
    bookingsCreated: String(result.bookingsCreated),
    bookingsUpdated: String(result.bookingsUpdated),
    bookingsCancelled: String(result.bookingsCancelled),
    eventsSkippedNoClientData: String(result.eventsSkippedNoClientData),
    eventsIgnoredNotAService: String(result.eventsIgnoredNotAService),
  });
  redirect(`/marketing/connections?${params.toString()}`);
}
