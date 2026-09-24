import Link from "next/link";
import { TRPCError } from "@trpc/server";
import { createServerCaller } from "@bos/core";

function NoAccess() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-2 p-4 text-center">
      <h1 className="text-xl font-semibold">Accesso non consentito</h1>
      <p className="text-neutral-500 dark:text-neutral-400">
        I preventivi sono visibili solo agli account admin e dispatcher.
      </p>
      <Link href="/" className="text-sm underline">
        Torna alla dashboard
      </Link>
    </main>
  );
}

function formatDate(isoDate: string | null, time: string | null) {
  if (!isoDate) return "data da definire";
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}${time ? ` ore ${time}` : ""}`;
}

export default async function PendingQuotesPage() {
  const caller = await createServerCaller();

  let pending;
  try {
    pending = await caller.quoteApproval.pending();
  } catch (error) {
    if (error instanceof TRPCError && error.code === "FORBIDDEN") return <NoAccess />;
    throw error;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-5 p-4">
      <div>
        <Link href="/" className="text-sm text-neutral-500 underline dark:text-neutral-400">
          ← Dashboard
        </Link>
      </div>
      <h1 className="text-2xl font-semibold">Preventivi in attesa</h1>

      {!pending.enabled ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Il flusso preventivi è disattivato (QUOTE_APPROVAL_ENABLED). Nessun preventivo automatico da gestire.
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Da approvare ({pending.quotes.length})
        </h2>
        {pending.quotes.length === 0 ? (
          <p className="text-sm text-neutral-400">Nessun preventivo da approvare.</p>
        ) : (
          pending.quotes.map(({ round, transferRequest: tr, client, view, ref }) => (
            <Link
              key={round.id}
              href={`/preventivi/${round.id}`}
              className="flex flex-col gap-1 rounded-lg border p-4 active:bg-neutral-50 dark:active:bg-neutral-900"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{client.fullName}</span>
                <span className="text-lg font-semibold">{view.amountLabel}</span>
              </div>
              <div className="text-sm">
                {tr.pickup} → {tr.destination}
              </div>
              <div className="text-sm text-neutral-500 dark:text-neutral-400">
                {formatDate(tr.requestedDate, tr.requestedTime)} · {tr.passengers ?? "?"} pax · {ref}
                {round.proposedAmountCents !== null ? " · prezzo modificato" : ""}
              </div>
            </Link>
          ))
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Prezzo da inserire ({pending.manualPrices.length})
        </h2>
        {pending.manualPrices.length === 0 ? (
          <p className="text-sm text-neutral-400">Nessuna richiesta senza prezzo.</p>
        ) : (
          pending.manualPrices.map(({ round, text }) => (
            <pre
              key={round.id}
              className="whitespace-pre-wrap rounded-lg border p-4 font-sans text-sm"
            >
              {text}
            </pre>
          ))
        )}
      </section>
    </main>
  );
}
