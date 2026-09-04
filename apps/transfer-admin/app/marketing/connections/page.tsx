import Link from "next/link";
import { TRPCError } from "@trpc/server";
import { createServerCaller } from "@bos/core";
import type { AvailableCalendar } from "@bos/core";
import { PermissionDenied } from "../permission-denied";
import {
  addLinkedResourceAction,
  disconnectConnectionAction,
  removeLinkedResourceAction,
  selectCalendarAction,
  syncCalendarNowAction,
} from "./actions";

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  google_ads_account: "Google Ads account",
  ga4_property: "GA4 property",
  gtm_container: "GTM container",
  search_console_site: "Search Console site",
};

const RESOURCE_ID_HINTS: Record<string, string> = {
  google_ads_account: "e.g. 123-456-7890",
  ga4_property: "e.g. properties/123456789",
  gtm_container: "e.g. GTM-XXXXXXX",
  search_console_site: "e.g. https://www.bonolinitransfer.com/",
};

function formatDate(value: Date | string) {
  return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export default async function MarketingConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const connected = sp.connected === "1";
  const errorParam = Array.isArray(sp.error) ? sp.error[0] : sp.error;
  const syncResult =
    sp.synced === "1"
      ? {
          eventsSeen: Number(sp.eventsSeen) || 0,
          bookingsCreated: Number(sp.bookingsCreated) || 0,
          bookingsUpdated: Number(sp.bookingsUpdated) || 0,
          bookingsCancelled: Number(sp.bookingsCancelled) || 0,
          eventsSkippedNoClientData: Number(sp.eventsSkippedNoClientData) || 0,
          eventsIgnoredNotAService: Number(sp.eventsIgnoredNotAService) || 0,
        }
      : null;

  const caller = await createServerCaller();

  let status;
  let resources;
  try {
    [status, resources] = await Promise.all([
      caller.marketing.getConnectionStatus(),
      caller.marketing.listLinkedResources(),
    ]);
  } catch (error) {
    if (error instanceof TRPCError && error.code === "FORBIDDEN") {
      return <PermissionDenied />;
    }
    throw error;
  }

  const isActive = status.status === "active";

  // Calendar is never required for the rest of BOS to work, and a missing
  // calendar.readonly scope on an older connection (pre-dating this
  // milestone) must never crash this whole page — kept in its own
  // try/catch, deliberately separate from the FORBIDDEN handling above.
  let calendarConfig = null;
  let availableCalendars: AvailableCalendar[] = [];
  let calendarError: string | null = null;
  if (isActive) {
    try {
      calendarConfig = await caller.calendar.getConfig();
      availableCalendars = await caller.calendar.listAvailableCalendars();
    } catch (error) {
      calendarError =
        error instanceof Error
          ? error.message
          : "Could not load Google Calendar — reconnect above to grant Calendar access.";
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <div>
        <Link href="/" className="text-sm text-neutral-500 underline dark:text-neutral-400">
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold">Marketing Intelligence — Connections</h1>
        <p className="text-neutral-500 dark:text-neutral-400">
          MIE-1: connection foundation only. Monitoring, anomaly detection, and
          reports aren&apos;t built yet — see packages/core/src/marketing/README.md.
        </p>
      </div>

      {connected ? (
        <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400">
          Google account connected.
        </p>
      ) : null}
      {errorParam ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          Connection error: {errorParam}
        </p>
      ) : null}
      {syncResult ? (
        <div className="rounded border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300">
          <p className="font-medium">
            Sync complete: {syncResult.eventsSeen} event{syncResult.eventsSeen === 1 ? "" : "s"} seen —{" "}
            {syncResult.bookingsCreated} created, {syncResult.bookingsUpdated} updated,{" "}
            {syncResult.bookingsCancelled} cancelled.
          </p>
          {syncResult.eventsSkippedNoClientData > 0 ? (
            <p className="mt-1">
              {syncResult.eventsSkippedNoClientData} event{syncResult.eventsSkippedNoClientData === 1 ? "" : "s"}{" "}
              skipped — recognized as a service (a route was found) but no phone number could be read from the
              event description, so no client could be identified or created. Add a &quot;Tel: ...&quot; or
              &quot;Phone: ...&quot; to the event description to fix this.
            </p>
          ) : null}
          {syncResult.eventsIgnoredNotAService > 0 ? (
            <p className="mt-1">
              {syncResult.eventsIgnoredNotAService} event{syncResult.eventsIgnoredNotAService === 1 ? "" : "s"}{" "}
              ignored — no recognizable pickup/destination route in the title.
            </p>
          ) : null}
        </div>
      ) : null}

      <section className="rounded border p-4">
        <h2 className="mb-2 text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Google account connection
        </h2>

        {status.status === "none" || status.status === "revoked" ? (
          <div className="space-y-2">
            <p className="text-sm">No Google account connected.</p>
            <a
              href="/api/marketing/oauth/start"
              className="inline-block rounded bg-neutral-900 px-4 py-2 text-sm text-white"
            >
              Connect Google Account
            </a>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <span
                className={
                  isActive
                    ? "rounded bg-green-100 px-2 py-0.5 text-xs text-green-800 dark:bg-green-900 dark:text-green-300"
                    : "rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300"
                }
              >
                {status.status}
              </span>
              {status.connectedAt ? <span>since {formatDate(status.connectedAt)}</span> : null}
            </div>
            <div>
              <div className="text-neutral-500 dark:text-neutral-400">Granted scopes</div>
              <ul className="list-disc pl-5">
                {status.scopes?.map((scope) => <li key={scope}>{scope}</li>)}
              </ul>
            </div>
            <div className="flex gap-2">
              <a href="/api/marketing/oauth/start" className="rounded border px-3 py-1.5 text-sm">
                Reconnect
              </a>
              <form action={disconnectConnectionAction}>
                <button type="submit" className="rounded border px-3 py-1.5 text-sm text-red-600">
                  Disconnect
                </button>
              </form>
            </div>
          </div>
        )}
      </section>

      {isActive ? (
        <section className="rounded border p-4">
          <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
            Monitored resources
          </h2>

          {resources.length === 0 ? (
            <p className="mb-4 text-sm text-neutral-400">
              Nothing linked yet — add the specific Google Ads account, GA4
              property, GTM container, or Search Console site to monitor.
            </p>
          ) : (
            <table className="mb-4 w-full text-left text-sm">
              <thead>
                <tr className="border-b text-neutral-500 dark:text-neutral-400">
                  <th className="py-2 pr-4">Type</th>
                  <th className="py-2 pr-4">ID</th>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {resources.map((resource) => (
                  <tr key={resource.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">{RESOURCE_TYPE_LABELS[resource.resourceType]}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{resource.externalId}</td>
                    <td className="py-2 pr-4">{resource.displayName ?? "—"}</td>
                    <td className="py-2 pr-4">
                      <form action={removeLinkedResourceAction}>
                        <input type="hidden" name="id" value={resource.id} />
                        <button type="submit" className="text-xs text-red-600 underline">
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <form action={addLinkedResourceAction} className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium">Type</label>
              <select
                name="resourceType"
                defaultValue="google_ads_account"
                className="rounded border px-3 py-1.5 text-sm"
              >
                {Object.entries(RESOURCE_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">ID</label>
              <input
                type="text"
                name="externalId"
                placeholder={RESOURCE_ID_HINTS.google_ads_account}
                className="w-56 rounded border px-3 py-1.5 text-sm"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Display name (optional)</label>
              <input
                type="text"
                name="displayName"
                className="w-48 rounded border px-3 py-1.5 text-sm"
              />
            </div>
            <button type="submit" className="rounded border px-4 py-1.5 text-sm">
              Add
            </button>
          </form>
        </section>
      ) : null}

      {isActive ? (
        <section className="rounded border p-4">
          <h2 className="mb-1 text-sm font-medium text-neutral-500 dark:text-neutral-400">
            Google Calendar
          </h2>
          <p className="mb-3 text-xs text-neutral-400">
            Read-only — BOS only ever reads this calendar, never creates, edits, or deletes an
            event. Optional: nothing else in BOS requires this to be configured.
          </p>

          {calendarError ? (
            <p className="rounded border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-300">
              {calendarError} Reconnect above to grant Calendar access.
            </p>
          ) : calendarConfig?.configured ? (
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-neutral-500 dark:text-neutral-400">Selected calendar</div>
                <div className="font-medium">
                  {calendarConfig.googleCalendarName ?? calendarConfig.googleCalendarId}
                </div>
                {calendarConfig.timezone ? (
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {calendarConfig.timezone}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={
                    calendarConfig.lastSyncStatus === "error"
                      ? "rounded bg-red-100 px-2 py-0.5 text-xs text-red-800 dark:bg-red-900 dark:text-red-300"
                      : calendarConfig.lastSyncStatus === "ok"
                        ? "rounded bg-green-100 px-2 py-0.5 text-xs text-green-800 dark:bg-green-900 dark:text-green-300"
                        : "rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }
                >
                  {calendarConfig.lastSyncStatus ?? "never synced"}
                </span>
                {calendarConfig.lastSyncedAt ? <span>last synced {formatDate(calendarConfig.lastSyncedAt)}</span> : null}
              </div>
              {calendarConfig.lastSyncError ? (
                <p className="text-xs text-red-600 dark:text-red-400">{calendarConfig.lastSyncError}</p>
              ) : null}
              <form action={syncCalendarNowAction}>
                <button type="submit" className="rounded border px-3 py-1.5 text-sm">
                  Sync now
                </button>
              </form>

              {availableCalendars.length > 0 ? (
                <details className="pt-1">
                  <summary className="cursor-pointer text-xs text-neutral-500 dark:text-neutral-400">
                    Change calendar
                  </summary>
                  <form action={selectCalendarAction} className="mt-2 flex flex-wrap items-end gap-3">
                    <select name="calendarChoice" className="rounded border px-3 py-1.5 text-sm" required>
                      {availableCalendars.map((cal) => (
                        <option key={cal.id} value={`${cal.id}|||${cal.name}|||${cal.timezone ?? ""}`}>
                          {cal.name}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="rounded border px-4 py-1.5 text-sm">
                      Select
                    </button>
                  </form>
                </details>
              ) : null}
            </div>
          ) : availableCalendars.length === 0 ? (
            <p className="text-sm text-neutral-400">
              No calendars found on the connected Google account.
            </p>
          ) : (
            <form action={selectCalendarAction} className="flex flex-wrap items-end gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium">
                  Which calendar is the Bonolini Transfer services calendar?
                </label>
                <select name="calendarChoice" className="w-64 rounded border px-3 py-1.5 text-sm" required>
                  {availableCalendars.map((cal) => (
                    <option key={cal.id} value={`${cal.id}|||${cal.name}|||${cal.timezone ?? ""}`}>
                      {cal.name}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className="rounded border px-4 py-1.5 text-sm">
                Select calendar
              </button>
            </form>
          )}
        </section>
      ) : null}
    </main>
  );
}
