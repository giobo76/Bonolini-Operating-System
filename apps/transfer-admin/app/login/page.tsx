"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@bos/auth/client";
import { loginRateLimiter } from "./rate-limit";

const LINK_ERROR_MESSAGES: Record<string, string> = {
  invalid_or_expired_link:
    "That password reset link is invalid or has expired. Request a new one below.",
};

function LinkErrorNotice() {
  const searchParams = useSearchParams();
  const errorCode = searchParams.get("error");
  const message = errorCode ? LINK_ERROR_MESSAGES[errorCode] : null;

  if (!message) return null;
  return <p className="text-sm text-red-600">{message}</p>;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const rateLimitKey = email.trim().toLowerCase();
    const rateLimitResult = loginRateLimiter(rateLimitKey);
    if (!rateLimitResult.ok) {
      setError("Too many login attempts. Please wait a few minutes and try again.");
      setSubmitting(false);
      return;
    }

    const supabase = createBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError(signInError.message);
      setSubmitting(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Bonolini Transfer — Admin</h1>
        <Suspense fallback={null}>
          <LinkErrorNotice />
        </Suspense>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="w-full rounded border px-3 py-2"
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded border px-3 py-2"
          required
        />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-50"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
        <a href="/forgot-password" className="block text-center text-sm underline">
          Forgot password?
        </a>
      </form>
    </main>
  );
}
