import Link from "next/link";
import { getSession } from "@bos/auth";
import { SignOutButton } from "./sign-out-button";

export default async function DashboardPage() {
  const session = await getSession();

  return (
    <main className="flex min-h-screen flex-col gap-4 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Bonolini Transfer — Admin</h1>
        <SignOutButton />
      </header>
      <p className="text-neutral-500 dark:text-neutral-400">
        Signed in as {session?.user.email ?? "unknown"} (
        {session?.profile.role ?? "no role"}).
      </p>

      <nav className="flex gap-3">
        <Link href="/customers" className="rounded border px-4 py-2 text-sm">
          Customers
        </Link>
        {session?.profile.role === "admin" ? (
          <Link href="/marketing" className="rounded border px-4 py-2 text-sm">
            Marketing Intelligence
          </Link>
        ) : null}
      </nav>

      <p className="text-neutral-500 dark:text-neutral-400">
        Dispatch, bookings, and driver management arrive as those features
        are built.
      </p>
    </main>
  );
}
