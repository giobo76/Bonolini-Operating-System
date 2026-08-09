import Link from "next/link";
import { TRPCError } from "@trpc/server";
import { COMMON_COUNTRIES, createServerCaller, type ListClientsInput } from "@bos/core";
import { PermissionDenied } from "./permission-denied";

function getParam(
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = searchParams[key];
  return Array.isArray(value) ? value[0] : value;
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  const search = getParam(sp, "search") ?? "";
  const customerType = getParam(sp, "customerType") as ListClientsInput["customerType"];
  const country = getParam(sp, "country") ?? "";
  const status = (getParam(sp, "status") as ListClientsInput["status"]) ?? "active";
  const page = Number(getParam(sp, "page") ?? "1") || 1;

  const caller = await createServerCaller();

  let result;
  try {
    result = await caller.clients.list({
      search: search || undefined,
      customerType: customerType || undefined,
      country: country || undefined,
      status,
      page,
      pageSize: 25,
    });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "FORBIDDEN") {
      return <PermissionDenied />;
    }
    throw error;
  }

  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const hasFilters = Boolean(search || customerType || country || status !== "active");

  // Preserve current filters across pagination links.
  const paramsFor = (targetPage: number) => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (customerType) params.set("customerType", customerType);
    if (country) params.set("country", country);
    if (status !== "active") params.set("status", status);
    params.set("page", String(targetPage));
    return `?${params.toString()}`;
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <Link href="/" className="text-sm text-neutral-500 underline dark:text-neutral-400">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-semibold">Customers</h1>
        </div>
        <Link
          href="/customers/new"
          className="rounded bg-neutral-900 px-4 py-2 text-sm text-white"
        >
          New customer
        </Link>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium">Search</label>
          <input
            type="text"
            name="search"
            defaultValue={search}
            placeholder="Name, company, email, phone…"
            className="w-64 rounded border px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Type</label>
          <select
            name="customerType"
            defaultValue={customerType ?? ""}
            className="rounded border px-3 py-1.5 text-sm"
          >
            <option value="">Any</option>
            <option value="private">Private</option>
            <option value="company">Company</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Country</label>
          <select
            name="country"
            defaultValue={country}
            className="rounded border px-3 py-1.5 text-sm"
          >
            <option value="">Any</option>
            {COMMON_COUNTRIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Status</label>
          <select
            name="status"
            defaultValue={status}
            className="rounded border px-3 py-1.5 text-sm"
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </select>
        </div>
        <button
          type="submit"
          className="rounded border px-4 py-1.5 text-sm"
        >
          Filter
        </button>
        {hasFilters ? (
          <Link href="/customers" className="text-sm underline">
            Clear
          </Link>
        ) : null}
      </form>

      {result.rows.length === 0 ? (
        <p className="text-neutral-500 dark:text-neutral-400">
          {hasFilters
            ? "No customers match your filters."
            : "No customers yet. Add your first customer."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-neutral-500 dark:text-neutral-400">
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Type</th>
                <th className="py-2 pr-4">Phone</th>
                <th className="py-2 pr-4">Email</th>
                <th className="py-2 pr-4">Country</th>
                <th className="py-2 pr-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((client) => (
                <tr key={client.id} className="border-b last:border-0">
                  <td className="py-2 pr-4">
                    <a href={`/customers/${client.id}`} className="underline">
                      {client.customerType === "company" && client.companyName
                        ? client.companyName
                        : client.fullName}
                    </a>
                  </td>
                  <td className="py-2 pr-4 capitalize">{client.customerType}</td>
                  <td className="py-2 pr-4">{client.phone}</td>
                  <td className="py-2 pr-4">{client.email ?? "—"}</td>
                  <td className="py-2 pr-4">{client.country ?? "—"}</td>
                  <td className="py-2 pr-4">
                    {client.deletedAt ? (
                      <span className="text-neutral-500">Archived</span>
                    ) : (
                      <span className="text-green-700 dark:text-green-500">Active</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result.total > 0 ? (
        <div className="flex items-center justify-between text-sm text-neutral-500 dark:text-neutral-400">
          <span>
            Page {result.page} of {totalPages} ({result.total} total)
          </span>
          <div className="flex gap-3">
            {page > 1 ? (
              <a href={paramsFor(page - 1)} className="underline">
                ← Previous
              </a>
            ) : null}
            {page < totalPages ? (
              <a href={paramsFor(page + 1)} className="underline">
                Next →
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}
