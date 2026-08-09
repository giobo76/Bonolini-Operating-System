import Link from "next/link";

export function PermissionDenied() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-xl font-semibold">You don&apos;t have access to Customers</h1>
      <p className="max-w-sm text-neutral-500 dark:text-neutral-400">
        This area is limited to admin and dispatcher accounts. Ask an admin
        to grant your account the right role.
      </p>
      <Link href="/" className="text-sm underline">
        Back to dashboard
      </Link>
    </main>
  );
}
