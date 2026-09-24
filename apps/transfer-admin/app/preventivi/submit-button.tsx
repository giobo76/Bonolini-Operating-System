"use client";

import { useFormStatus } from "react-dom";

// Disabled while the action runs, so a second tap on a slow phone
// connection can't submit again. The server is protected anyway (the
// second request gets "già approvato"); this just avoids the confusion.
export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant?: "primary" | "secondary" | "danger";
}) {
  const { pending } = useFormStatus();
  const styles = {
    primary: "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900",
    secondary: "border border-neutral-300 dark:border-neutral-700",
    danger: "border border-red-300 text-red-700 dark:border-red-800 dark:text-red-400",
  }[variant];

  return (
    <button
      type="submit"
      disabled={pending}
      className={`w-full rounded-lg px-4 py-3 text-base font-medium disabled:opacity-50 ${styles}`}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
