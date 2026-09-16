import Link from "next/link";

export function PermissionDenied() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-xl font-semibold">You don&apos;t have access to the BOS Agent</h1>
      <p className="max-w-sm text-neutral-500 dark:text-neutral-400">
        This area is admin-only — it can trigger and approve real agent
        actions, so dispatcher accounts can&apos;t see it.
      </p>
      <Link href="/" className="text-sm underline">
        Back to dashboard
      </Link>
    </main>
  );
}
