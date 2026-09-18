import Link from "next/link";

export function PermissionDenied() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-xl font-semibold">You don&apos;t have access to Business Rules</h1>
      <p className="max-w-sm text-neutral-500 dark:text-neutral-400">
        This area is admin-only — business rules belong exclusively to the founder, so dispatcher accounts can&apos;t
        see or approve them.
      </p>
      <Link href="/" className="text-sm underline">
        Back to dashboard
      </Link>
    </main>
  );
}
