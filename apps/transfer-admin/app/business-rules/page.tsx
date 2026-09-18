import Link from "next/link";
import { TRPCError } from "@trpc/server";
import { createServerCaller } from "@bos/core";
import { PermissionDenied } from "./permission-denied";
import { createRuleAction } from "./actions";

const CATEGORIES = ["pricing", "commercial_relevance", "commission_platform", "seasonality", "priority_weights", "other"] as const;

function formatDate(value: Date | string) {
  return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export default async function BusinessRulesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const errorParam = Array.isArray(sp.error) ? sp.error[0] : sp.error;

  const caller = await createServerCaller();

  let rules;
  try {
    rules = await caller.businessRules.list();
  } catch (error) {
    if (error instanceof TRPCError && error.code === "FORBIDDEN") {
      return <PermissionDenied />;
    }
    throw error;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header>
        <Link href="/" className="text-sm text-neutral-500 underline dark:text-neutral-400">
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold">Business Rules</h1>
        <p className="mt-1 max-w-xl text-xs text-neutral-500 dark:text-neutral-400">
          Business rules belong exclusively to the founder. The BOS can read, apply, analyze, and propose new
          versions — it can never approve, reject, or activate its own proposal. Only an admin can do that below.
        </p>
      </header>

      {errorParam ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {errorParam}
        </p>
      ) : null}

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">New rule</h2>
        <form action={createRuleAction} className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col">
            <label className="text-xs text-neutral-500 dark:text-neutral-400" htmlFor="key">
              Key
            </label>
            <input id="key" name="key" required placeholder="pricing.fixed_fare.malpensa_airport" className="rounded border px-2 py-1 text-sm" />
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-neutral-500 dark:text-neutral-400" htmlFor="category">
              Category
            </label>
            <select id="category" name="category" required className="rounded border px-2 py-1 text-sm">
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
            Create rule
          </button>
        </form>
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">Rules ({rules.length})</h2>
        {rules.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No business rules yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {rules.map((rule) => (
              <li key={rule.id} className="rounded border p-3">
                <Link href={`/business-rules/${rule.id}`} className="flex items-center justify-between">
                  <span className="font-medium">{rule.key}</span>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">{rule.category}</span>
                </Link>
                <div className="mt-1 text-xs text-neutral-400">
                  {rule.currentVersionId ? (
                    <span>current version set</span>
                  ) : (
                    <span className="text-yellow-600 dark:text-yellow-400">no effective version yet</span>
                  )}
                  {" · updated "}
                  {formatDate(rule.updatedAt)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
