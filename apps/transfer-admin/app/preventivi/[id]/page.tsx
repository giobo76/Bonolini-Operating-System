import Link from "next/link";
import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { createServerCaller } from "@bos/core";
import { approveAction, rejectAction, reviseAction } from "../actions";
import { SubmitButton } from "../submit-button";

const STATUS_LABELS: Record<string, string> = {
  awaiting_decision: "Da approvare",
  awaiting_price: "Da approvare",
  processing: "In elaborazione",
  approved: "Approvato",
  rejected: "Rifiutato",
  superseded: "Sostituito",
};

const RESULT_STYLES: Record<string, string> = {
  done: "border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-200",
  already: "border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900",
  refused: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  error: "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
};

function param(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function QuoteRoundPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const esito = param(sp.esito);
  const tipo = param(sp.tipo) ?? "done";

  const caller = await createServerCaller();
  let detail;
  try {
    detail = await caller.quoteApproval.get({ id });
  } catch (error) {
    if (error instanceof TRPCError && (error.code === "NOT_FOUND" || error.code === "BAD_REQUEST")) notFound();
    if (error instanceof TRPCError && error.code === "FORBIDDEN") {
      return (
        <main className="mx-auto max-w-xl p-4">
          <p>I preventivi sono visibili solo agli account admin e dispatcher.</p>
        </main>
      );
    }
    throw error;
  }

  const { round, view, ref, open, latestOpenRoundId } = detail;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-5 p-4">
      <div>
        <Link href="/preventivi" className="text-sm text-neutral-500 underline dark:text-neutral-400">
          ← Preventivi in attesa
        </Link>
      </div>

      <header className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Preventivo {ref}</h1>
        <span className="rounded bg-neutral-100 px-2 py-1 text-xs dark:bg-neutral-800">
          {STATUS_LABELS[round.status] ?? round.status}
        </span>
      </header>

      {esito ? (
        <p className={`whitespace-pre-wrap rounded-lg border p-3 text-sm ${RESULT_STYLES[tipo] ?? RESULT_STYLES.done}`}>
          {esito}
        </p>
      ) : null}

      {!open && latestOpenRoundId ? (
        <Link
          href={`/preventivi/${latestOpenRoundId}`}
          className="rounded-lg border p-3 text-center text-sm font-medium underline"
        >
          Questo preventivo è stato sostituito: apri quello aggiornato
        </Link>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">Dati della richiesta</h2>
        <pre className="whitespace-pre-wrap rounded-lg border p-4 font-sans text-sm">{view.founderDetails}</pre>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Testo che riceverà il cliente su WhatsApp
        </h2>
        <pre className="whitespace-pre-wrap rounded-lg bg-green-50 p-4 font-sans text-sm dark:bg-green-950">
          {view.customerPreview}
        </pre>
      </section>

      {open ? (
        <section className="flex flex-col gap-4 border-t pt-4">
          <form action={approveAction}>
            <input type="hidden" name="id" value={round.id} />
            <SubmitButton pendingLabel="Invio in corso…">Approva e invia al cliente</SubmitButton>
          </form>

          <form action={reviseAction} className="flex flex-col gap-2 rounded-lg border p-3">
            <input type="hidden" name="id" value={round.id} />
            <label htmlFor="prezzo" className="text-sm font-medium">
              Modifica il prezzo (€)
            </label>
            <input
              id="prezzo"
              name="prezzo"
              inputMode="decimal"
              required
              placeholder={(view.amountCents / 100).toFixed(2).replace(".", ",")}
              className="rounded-lg border px-3 py-3 text-base"
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Crea un nuovo preventivo con il nuovo prezzo; poi lo controlli e lo approvi. Al cliente non parte
              nulla finché non premi Approva.
            </p>
            <SubmitButton variant="secondary" pendingLabel="Salvataggio…">
              Modifica
            </SubmitButton>
          </form>

          <form action={rejectAction}>
            <input type="hidden" name="id" value={round.id} />
            <SubmitButton variant="danger" pendingLabel="Rifiuto in corso…">
              Rifiuta (al cliente non parte nulla)
            </SubmitButton>
          </form>
        </section>
      ) : null}
    </main>
  );
}
