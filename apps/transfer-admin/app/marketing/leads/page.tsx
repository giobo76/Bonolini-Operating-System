import Link from "next/link";
import { TRPCError } from "@trpc/server";
import { createServerCaller, type MarketingLead } from "@bos/core";
import { PermissionDenied } from "../permission-denied";
import { linkLeadToClientAction } from "./actions";

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  phone: "Phone",
  email: "Email",
  form: "Form",
};

// The list fetch always uses this fixed limit (listUnlinkedLeadsSchema's own
// max) — the "linking" panel below finds its lead in this same array by id
// rather than adding a second, single-lead lookup procedure that doesn't
// exist in the service layer today.
const LIST_LIMIT = 100;

function getParam(searchParams: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = searchParams[key];
  return Array.isArray(value) ? value[0] : value;
}

function formatDate(value: Date | string) {
  return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function describeSource(lead: MarketingLead): string {
  if (lead.utmCampaign) return lead.utmCampaign;
  if (lead.utmSource) return lead.utmSource;
  if (lead.gclid) return "Google Ads (untagged)";
  return "Organic / direct";
}

export default async function MarketingLeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const channel = getParam(sp, "channel") ?? "";
  const linking = getParam(sp, "linking") ?? "";
  const search = getParam(sp, "search") ?? "";
  const linked = sp.linked === "1";
  const errorParam = getParam(sp, "error");

  const caller = await createServerCaller();

  let leads: MarketingLead[];
  try {
    leads = await caller.marketing.listUnlinkedLeads({
      channel: (channel || undefined) as MarketingLead["channel"] | undefined,
      limit: LIST_LIMIT,
    });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "FORBIDDEN") {
      return <PermissionDenied />;
    }
    throw error;
  }

  // Found in the list already fetched above, never a separate lookup by a
  // caller-supplied id — a stale or foreign-tenant "linking" id simply
  // fails to match anything here and the panel doesn't render, rather than
  // trusting the query param.
  const linkingLead = linking ? leads.find((lead) => lead.id === linking) : undefined;

  // Client search only runs once the staff member has actually typed
  // something — this is the one place matching happens, and it is always a
  // human typing a query and reading real results, never an automatic
  // lookup by the lead's own gclid/utm/visitor data.
  const clientResults =
    linkingLead && search.trim().length > 0
      ? await caller.clients.list({ search: search.trim(), status: "active", pageSize: 10 })
      : null;

  // Builds a single, correctly-formed query string (never a double "?") —
  // channel is only included when actually set, exactly like paramsFor in
  // apps/transfer-admin/app/customers/page.tsx.
  function linkingHref(targetChannel: string, leadId: string): string {
    const params = new URLSearchParams();
    if (targetChannel) params.set("channel", targetChannel);
    params.set("linking", leadId);
    return `?${params.toString()}`;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header>
        <Link href="/marketing" className="text-sm text-neutral-500 underline dark:text-neutral-400">
          ← Marketing Intelligence
        </Link>
        <h1 className="text-2xl font-semibold">Unlinked Leads</h1>
        <p className="mt-1 text-xs text-neutral-400">
          Marketing intent (ad clicks, WhatsApp/phone/email/form contacts) not yet linked to a
          real client record. Linking is always manual: search for the real customer below and
          confirm explicitly — nothing here is ever matched automatically by name, phone, or
          email.
        </p>
      </header>

      {linked ? (
        <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400">
          Lead linked to client.
        </p>
      ) : null}
      {errorParam ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {errorParam}
        </p>
      ) : null}

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium">Channel</label>
          <select name="channel" defaultValue={channel} className="rounded border px-3 py-1.5 text-sm">
            <option value="">Any</option>
            {Object.entries(CHANNEL_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="rounded border px-4 py-1.5 text-sm">
          Filter
        </button>
        {channel ? (
          <Link href="/marketing/leads" className="text-sm underline">
            Clear
          </Link>
        ) : null}
      </form>

      {leads.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          No unlinked leads{channel ? ` for channel "${CHANNEL_LABELS[channel] ?? channel}"` : ""}.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-neutral-500 dark:text-neutral-400">
              <th className="py-2 pr-4">Channel</th>
              <th className="py-2 pr-4">Source</th>
              <th className="py-2 pr-4">Landing page</th>
              <th className="py-2 pr-4">Received</th>
              <th className="py-2 pr-4" />
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id} className="border-b last:border-0">
                <td className="py-2 pr-4">{CHANNEL_LABELS[lead.channel] ?? lead.channel}</td>
                <td className="py-2 pr-4">{describeSource(lead)}</td>
                <td className="max-w-xs truncate py-2 pr-4">{lead.landingPage ?? "—"}</td>
                <td className="py-2 pr-4">{formatDate(lead.createdAt)}</td>
                <td className="py-2 pr-4">
                  <a href={linkingHref(channel, lead.id)} className="text-sm underline">
                    {linking === lead.id ? "Linking…" : "Link to client →"}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {linkingLead ? (
        <section className="rounded border p-4">
          <h2 className="mb-1 text-sm font-medium text-neutral-500 dark:text-neutral-400">
            Link this lead to a real client
          </h2>
          <dl className="mb-4 space-y-1 text-sm">
            <div>
              <dt className="inline text-neutral-500 dark:text-neutral-400">Channel: </dt>
              <dd className="inline">{CHANNEL_LABELS[linkingLead.channel] ?? linkingLead.channel}</dd>
            </div>
            <div>
              <dt className="inline text-neutral-500 dark:text-neutral-400">Source: </dt>
              <dd className="inline">{describeSource(linkingLead)}</dd>
            </div>
            {linkingLead.landingPage ? (
              <div>
                <dt className="inline text-neutral-500 dark:text-neutral-400">Landing page: </dt>
                <dd className="inline">{linkingLead.landingPage}</dd>
              </div>
            ) : null}
            {linkingLead.referrer ? (
              <div>
                <dt className="inline text-neutral-500 dark:text-neutral-400">Referrer: </dt>
                <dd className="inline">{linkingLead.referrer}</dd>
              </div>
            ) : null}
            {linkingLead.gclid ? (
              <div>
                <dt className="inline text-neutral-500 dark:text-neutral-400">gclid: </dt>
                <dd className="inline font-mono text-xs">{linkingLead.gclid}</dd>
              </div>
            ) : null}
            <div>
              <dt className="inline text-neutral-500 dark:text-neutral-400">Received: </dt>
              <dd className="inline">{formatDate(linkingLead.createdAt)}</dd>
            </div>
          </dl>

          <form method="get" className="mb-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="channel" value={channel} />
            <input type="hidden" name="linking" value={linkingLead.id} />
            <div>
              <label className="mb-1 block text-xs font-medium">Search for the real client</label>
              <input
                type="text"
                name="search"
                defaultValue={search}
                placeholder="Name, company, email, phone…"
                className="w-72 rounded border px-3 py-1.5 text-sm"
                autoFocus
              />
            </div>
            <button type="submit" className="rounded border px-4 py-1.5 text-sm">
              Search
            </button>
          </form>

          {search.trim().length === 0 ? (
            <p className="text-sm text-neutral-400">
              Type a name, company, email, or phone number above to find the real client — no
              results are shown until you search.
            </p>
          ) : clientResults && clientResults.rows.length === 0 ? (
            <p className="text-sm text-neutral-400">
              No clients match &quot;{search}&quot;. Try a different search, or create the
              client first from the{" "}
              <Link href="/customers/new" className="underline">
                Customers
              </Link>{" "}
              page.
            </p>
          ) : clientResults ? (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-neutral-500 dark:text-neutral-400">
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Phone</th>
                  <th className="py-2 pr-4">Email</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {clientResults.rows.map((client) => (
                  <tr key={client.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">
                      {client.customerType === "company" && client.companyName ? client.companyName : client.fullName}
                    </td>
                    <td className="py-2 pr-4">{client.phone}</td>
                    <td className="py-2 pr-4">{client.email ?? "—"}</td>
                    <td className="py-2 pr-4">
                      <form action={linkLeadToClientAction}>
                        <input type="hidden" name="marketingLeadId" value={linkingLead.id} />
                        <input type="hidden" name="clientId" value={client.id} />
                        <button type="submit" className="rounded bg-neutral-900 px-3 py-1 text-xs text-white">
                          Link this lead to this client
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
