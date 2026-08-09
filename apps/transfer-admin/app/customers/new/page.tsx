import Link from "next/link";
import { createCustomerAction } from "../actions";
import { CustomerFormFields } from "../customer-form-fields";

export default async function NewCustomerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const error = sp.error;
  const errorMessage = Array.isArray(error) ? error[0] : error;

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-6 p-8">
      <div>
        <Link href="/customers" className="text-sm text-neutral-500 underline dark:text-neutral-400">
          ← Customers
        </Link>
        <h1 className="text-2xl font-semibold">New customer</h1>
      </div>

      <form action={createCustomerAction} className="space-y-4">
        {errorMessage ? (
          <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
            {errorMessage}
          </p>
        ) : null}
        <CustomerFormFields />
        <button
          type="submit"
          className="w-full rounded bg-neutral-900 px-3 py-2 text-white"
        >
          Create customer
        </button>
      </form>
    </main>
  );
}
