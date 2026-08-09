import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";
import { createServerCaller } from "@bos/core";
import { PermissionDenied } from "../../permission-denied";
import { updateCustomerAction } from "../../actions";
import { CustomerFormFields } from "../../customer-form-fields";

export default async function EditCustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const error = sp.error;
  const errorMessage = Array.isArray(error) ? error[0] : error;

  const caller = await createServerCaller();

  let client;
  try {
    client = await caller.clients.get({ id });
  } catch (err) {
    if (err instanceof TRPCError) {
      if (err.code === "FORBIDDEN") return <PermissionDenied />;
      if (err.code === "NOT_FOUND") notFound();
    }
    throw err;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-6 p-8">
      <div>
        <a
          href={`/customers/${id}`}
          className="text-sm text-neutral-500 underline dark:text-neutral-400"
        >
          ← {client.customerType === "company" && client.companyName ? client.companyName : client.fullName}
        </a>
        <h1 className="text-2xl font-semibold">Edit customer</h1>
      </div>

      <form action={updateCustomerAction} className="space-y-4">
        <input type="hidden" name="id" value={client.id} />
        {errorMessage ? (
          <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
            {errorMessage}
          </p>
        ) : null}
        <CustomerFormFields
          defaultValues={{
            customerType: client.customerType,
            fullName: client.fullName,
            companyName: client.companyName,
            email: client.email,
            phone: client.phone,
            country: client.country,
            preferredLanguage: client.preferredLanguage,
            notes: client.notes,
            marketingConsent: client.marketingConsent,
          }}
        />
        <button
          type="submit"
          className="w-full rounded bg-neutral-900 px-3 py-2 text-white"
        >
          Save changes
        </button>
      </form>
    </main>
  );
}
