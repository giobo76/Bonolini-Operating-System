import Link from "next/link";
import { TRPCError } from "@trpc/server";
import { createServerCaller } from "@bos/core";
import { confirmDepositAction, enterManualPriceAction } from "./actions";
import { SubmitButton } from "./submit-button";

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

export default async function PendingQuotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const esito = typeof sp.esito === "string" ? sp.esito : undefined;
  const esitoOk = sp.tipo === "done" || sp.tipo === "already";
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

      {esito ? (
        <p
          className={`whitespace-pre-wrap rounded-lg border p-3 text-sm ${
            esitoOk
              ? "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
              : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          }`}
        >
          {esito}
        </p>
      ) : null}

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
          In attesa di acconto ({pending.pendingDeposits.length})
        </h2>
        {pending.pendingDeposits.length === 0 ? (
          <p className="text-sm text-neutral-400">Nessuna prenotazione in attesa di acconto.</p>
        ) : (
          pending.pendingDeposits.map(({ booking, transferRequest: tr, client, depositLabel, totalLabel, ref }) => (
            <div key={booking.id} className="flex flex-col gap-2 rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <Link href={`/customers/${client.id}`} className="font-medium underline">
                  {client.fullName}
                </Link>
                <span className="text-sm text-neutral-500 dark:text-neutral-400">{ref}</span>
              </div>
              <div className="text-sm">
                {tr.pickup} → {tr.destination} · {formatDate(tr.requestedDate, tr.requestedTime)}
              </div>
              <div className="text-sm">
                Totale {totalLabel} · <strong>acconto {depositLabel}</strong>
              </div>
              <form action={confirmDepositAction} className="flex flex-col gap-2">
                <input type="hidden" name="bookingId" value={booking.id} />
                <input type="hidden" name="back" value="/preventivi" />
                <SubmitButton pendingLabel="Conferma in corso…">
                  Acconto ricevuto — conferma e avvisa il cliente
                </SubmitButton>
              </form>
            </div>
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
            <div key={round.id} className="flex flex-col gap-3 rounded-lg border p-4">
              <pre className="whitespace-pre-wrap font-sans text-sm">{text}</pre>
              <form action={enterManualPriceAction} className="flex flex-col gap-2">
                <input type="hidden" name="id" value={round.id} />
                <label htmlFor={`prezzo-${round.id}`} className="text-sm font-medium">
                  Prezzo (€)
                </label>
                <input
                  id={`prezzo-${round.id}`}
                  name="prezzo"
                  inputMode="decimal"
                  required
                  placeholder="es. 280"
                  className="rounded-lg border px-3 py-3 text-base"
                />
                <label htmlFor={`acconto-${round.id}`} className="text-sm font-medium">
                  Acconto (€, facoltativo)
                </label>
                <input
                  id={`acconto-${round.id}`}
                  name="acconto"
                  inputMode="decimal"
                  placeholder="vuoto = 50% arrotondato"
                  className="rounded-lg border px-3 py-3 text-base"
                />
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Crea il PREVENTIVO PRONTO con questo prezzo e acconto: poi lo controlli e scegli Approva, Modifica o Rifiuta.
                  Al cliente non parte nulla finché non premi Approva.
                </p>
                <SubmitButton pendingLabel="Creazione in corso…">Crea preventivo</SubmitButton>
              </form>
            </div>
          ))
        )}
      </section>
    </main>
  );
}
