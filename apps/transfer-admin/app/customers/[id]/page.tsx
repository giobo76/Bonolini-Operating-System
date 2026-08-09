import Link from "next/link";
import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";
import { createServerCaller } from "@bos/core";
import { PermissionDenied } from "../permission-denied";
import { archiveCustomerAction, restoreCustomerAction } from "../actions";
import {
  createBookingAction,
  createQuoteAction,
  updateBookingAction,
  updateQuoteStatusAction,
} from "./actions";

function formatDate(value: Date | string) {
  return new Date(value).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatMoney(cents: number | null, currency = "EUR") {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(cents / 100);
}

function acquisitionSourceLabel(client: {
  utmCampaign: string | null;
  utmSource: string | null;
  gclid: string | null;
}) {
  if (client.utmCampaign) return client.utmCampaign;
  if (client.utmSource) return client.utmSource;
  if (client.gclid) return "Google Ads (untagged)";
  return "Organic / direct";
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const caller = await createServerCaller();

  let client;
  try {
    client = await caller.clients.get({ id });
  } catch (error) {
    if (error instanceof TRPCError) {
      if (error.code === "FORBIDDEN") return <PermissionDenied />;
      if (error.code === "NOT_FOUND") notFound();
    }
    throw error;
  }

  const [clientQuotes, clientBookings] = await Promise.all([
    caller.quotes.listForClient({ clientId: id }),
    caller.bookings.listForClient({ clientId: id }),
  ]);

  const displayName =
    client.customerType === "company" && client.companyName
      ? client.companyName
      : client.fullName;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <div>
        <Link href="/customers" className="text-sm text-neutral-500 underline dark:text-neutral-400">
          ← Customers
        </Link>
      </div>

      <header className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{displayName}</h1>
            <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs capitalize dark:bg-neutral-800">
              {client.customerType}
            </span>
            {client.deletedAt ? (
              <span className="rounded bg-neutral-200 px-2 py-0.5 text-xs dark:bg-neutral-700">
                Archived
              </span>
            ) : null}
          </div>
          {client.customerType === "company" && client.companyName ? (
            <p className="text-neutral-500 dark:text-neutral-400">
              Contact: {client.fullName}
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <a
            href={`/customers/${client.id}/edit`}
            className="rounded border px-3 py-1.5 text-sm"
          >
            Edit
          </a>
          {client.deletedAt ? (
            <form action={restoreCustomerAction}>
              <input type="hidden" name="id" value={client.id} />
              <button type="submit" className="rounded border px-3 py-1.5 text-sm">
                Restore
              </button>
            </form>
          ) : (
            <form action={archiveCustomerAction}>
              <input type="hidden" name="id" value={client.id} />
              <button type="submit" className="rounded border px-3 py-1.5 text-sm text-red-600">
                Archive
              </button>
            </form>
          )}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-4 rounded border p-4 text-sm">
        <div>
          <div className="text-neutral-500 dark:text-neutral-400">Phone</div>
          <div>{client.phone}</div>
        </div>
        <div>
          <div className="text-neutral-500 dark:text-neutral-400">Email</div>
          <div>{client.email ?? "—"}</div>
        </div>
        <div>
          <div className="text-neutral-500 dark:text-neutral-400">Country</div>
          <div>{client.country ?? "—"}</div>
        </div>
        <div>
          <div className="text-neutral-500 dark:text-neutral-400">
            Preferred language
          </div>
          <div>{client.preferredLanguage ?? "—"}</div>
        </div>
        <div>
          <div className="text-neutral-500 dark:text-neutral-400">
            Marketing consent
          </div>
          <div>{client.marketingConsent ? "Yes" : "No"}</div>
        </div>
        <div>
          <div className="text-neutral-500 dark:text-neutral-400">Customer since</div>
          <div>{formatDate(client.createdAt)}</div>
        </div>
        <div>
          <div className="text-neutral-500 dark:text-neutral-400">Acquisition source</div>
          <div>{acquisitionSourceLabel(client)}</div>
        </div>
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-2 text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Notes
        </h2>
        {client.notes ? (
          <p className="whitespace-pre-wrap text-sm">{client.notes}</p>
        ) : (
          <p className="text-sm text-neutral-400">No notes on file.</p>
        )}
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Quotes
        </h2>
        {clientQuotes.length === 0 ? (
          <p className="mb-4 text-sm text-neutral-400">No quotes yet.</p>
        ) : (
          <ul className="mb-4 space-y-2 text-sm">
            {clientQuotes.map((quote) => (
              <li key={quote.id} className="flex items-center justify-between rounded border p-2">
                <div>
                  <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs capitalize dark:bg-neutral-800">
                    {quote.status}
                  </span>{" "}
                  {formatMoney(quote.amountCents, quote.currency)} —{" "}
                  <span className="text-neutral-500 dark:text-neutral-400">
                    {formatDate(quote.createdAt)}
                  </span>
                </div>
                {quote.status === "draft" || quote.status === "sent" ? (
                  <div className="flex gap-2">
                    <form action={updateQuoteStatusAction}>
                      <input type="hidden" name="clientId" value={id} />
                      <input type="hidden" name="id" value={quote.id} />
                      <input type="hidden" name="status" value="accepted" />
                      <button type="submit" className="text-xs underline">
                        Accept
                      </button>
                    </form>
                    <form action={updateQuoteStatusAction}>
                      <input type="hidden" name="clientId" value={id} />
                      <input type="hidden" name="id" value={quote.id} />
                      <input type="hidden" name="status" value="declined" />
                      <button type="submit" className="text-xs text-red-600 underline">
                        Decline
                      </button>
                    </form>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <form action={createQuoteAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="clientId" value={id} />
          <div>
            <label className="mb-1 block text-xs font-medium">Amount (€)</label>
            <input
              type="number"
              step="0.01"
              name="amount"
              className="w-32 rounded border px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Notes</label>
            <input type="text" name="notes" className="w-48 rounded border px-3 py-1.5 text-sm" />
          </div>
          <button type="submit" className="rounded border px-4 py-1.5 text-sm">
            Add quote
          </button>
        </form>
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Bookings
        </h2>
        {clientBookings.length === 0 ? (
          <p className="mb-4 text-sm text-neutral-400">No bookings yet.</p>
        ) : (
          <ul className="mb-4 space-y-3 text-sm">
            {clientBookings.map((booking) => (
              <li key={booking.id} className="space-y-2 rounded border p-3">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs capitalize dark:bg-neutral-800">
                    {booking.status}
                  </span>
                  <span className="text-neutral-500 dark:text-neutral-400">
                    Created {formatDate(booking.createdAt)}
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-1 sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-neutral-500 dark:text-neutral-400">Final amount</dt>
                    <dd>{formatMoney(booking.finalAmountCents, booking.currency)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-neutral-500 dark:text-neutral-400">Deposit</dt>
                    <dd>
                      {formatMoney(booking.depositAmountCents, booking.currency)}
                      {booking.depositPaidAt ? ` (${formatDate(booking.depositPaidAt)})` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-neutral-500 dark:text-neutral-400">Invoiced</dt>
                    <dd>
                      {formatMoney(booking.invoiceAmountCents, booking.currency)}
                      {booking.invoicedAt ? ` (${formatDate(booking.invoicedAt)})` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-neutral-500 dark:text-neutral-400">Paid</dt>
                    <dd>
                      {formatMoney(booking.paidAmountCents, booking.currency)}
                      {booking.paidAt ? ` (${formatDate(booking.paidAt)})` : ""}
                    </dd>
                  </div>
                </dl>

                <div className="flex flex-wrap gap-3 pt-1">
                  {booking.status === "confirmed" && !booking.depositPaidAt ? (
                    <form action={updateBookingAction} className="flex items-end gap-1">
                      <input type="hidden" name="clientId" value={id} />
                      <input type="hidden" name="id" value={booking.id} />
                      <input
                        type="number"
                        step="0.01"
                        name="depositAmount"
                        placeholder="Deposit €"
                        required
                        className="w-24 rounded border px-2 py-1 text-xs"
                      />
                      <button type="submit" className="text-xs underline">
                        Record deposit
                      </button>
                    </form>
                  ) : null}

                  {booking.status === "confirmed" ? (
                    <>
                      <form action={updateBookingAction}>
                        <input type="hidden" name="clientId" value={id} />
                        <input type="hidden" name="id" value={booking.id} />
                        <input type="hidden" name="status" value="completed" />
                        <button type="submit" className="text-xs underline">
                          Mark completed
                        </button>
                      </form>
                      <form action={updateBookingAction}>
                        <input type="hidden" name="clientId" value={id} />
                        <input type="hidden" name="id" value={booking.id} />
                        <input type="hidden" name="status" value="cancelled" />
                        <button type="submit" className="text-xs text-red-600 underline">
                          Cancel
                        </button>
                      </form>
                    </>
                  ) : null}

                  {booking.status === "completed" && !booking.invoicedAt ? (
                    <form action={updateBookingAction} className="flex items-end gap-1">
                      <input type="hidden" name="clientId" value={id} />
                      <input type="hidden" name="id" value={booking.id} />
                      <input
                        type="number"
                        step="0.01"
                        name="invoiceAmount"
                        placeholder="Invoice €"
                        required
                        className="w-24 rounded border px-2 py-1 text-xs"
                      />
                      <button type="submit" className="text-xs underline">
                        Record invoice
                      </button>
                    </form>
                  ) : null}

                  {booking.invoicedAt && !booking.paidAt ? (
                    <form action={updateBookingAction} className="flex items-end gap-1">
                      <input type="hidden" name="clientId" value={id} />
                      <input type="hidden" name="id" value={booking.id} />
                      <input
                        type="number"
                        step="0.01"
                        name="paidAmount"
                        placeholder="Paid €"
                        required
                        className="w-24 rounded border px-2 py-1 text-xs"
                      />
                      <button type="submit" className="text-xs underline">
                        Record payment
                      </button>
                    </form>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        <form action={createBookingAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="clientId" value={id} />
          <div>
            <label className="mb-1 block text-xs font-medium">From quote (optional)</label>
            <select name="quoteId" className="rounded border px-3 py-1.5 text-sm">
              <option value="">— none —</option>
              {clientQuotes
                .filter((q) => q.status === "accepted")
                .map((q) => (
                  <option key={q.id} value={q.id}>
                    {formatMoney(q.amountCents, q.currency)} ({formatDate(q.createdAt)})
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Final amount (€)</label>
            <input
              type="number"
              step="0.01"
              name="finalAmount"
              className="w-32 rounded border px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Scheduled at</label>
            <input
              type="datetime-local"
              name="scheduledAt"
              className="rounded border px-3 py-1.5 text-sm"
            />
          </div>
          <button type="submit" className="rounded border px-4 py-1.5 text-sm">
            Confirm booking
          </button>
        </form>
      </section>

      <p className="text-xs text-neutral-400">
        Last updated {formatDate(client.updatedAt)}
      </p>
    </main>
  );
}
