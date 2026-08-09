"use client";

import { useState } from "react";
import { createBrowserClient } from "@bos/auth/client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setStatus("sending");

    const supabase = createBrowserClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email,
      {
        redirectTo: `${window.location.origin}/auth/confirm?next=/reset-password`,
      },
    );

    // Always show the same success state, whether or not the email exists,
    // so this page can't be used to enumerate registered accounts.
    if (resetError) {
      setError(resetError.message);
      setStatus("idle");
      return;
    }

    setStatus("sent");
  }

  if (status === "sent") {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-xl font-semibold">Check your email</h1>
          <p className="text-neutral-500 dark:text-neutral-400">
            If an account exists for {email}, a password reset link is on its
            way.
          </p>
          <a href="/login" className="text-sm underline">
            Back to sign in
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Reset your password</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Enter your email and we&apos;ll send you a reset link.
        </p>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="w-full rounded border px-3 py-2"
          required
        />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={status === "sending"}
          className="w-full rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-50"
        >
          {status === "sending" ? "Sending…" : "Send reset link"}
        </button>
        <a href="/login" className="block text-center text-sm underline">
          Back to sign in
        </a>
      </form>
    </main>
  );
}
