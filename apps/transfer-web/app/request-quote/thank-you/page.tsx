import Link from "next/link";

// The "generate_lead" GA4 event (what
// packages/core/src/marketing/checks/ga4-checks.ts checks for under
// "conversion_tracking") used to be pushed client-side from this page via
// window.dataLayer. Removed: a real, read-only inspection of the live GTM
// container (2026-08-28) confirmed it has no trigger or tag configured to
// react to a "generate_lead" custom event at all, so the push had nowhere
// to go — GA4 recorded 0 of these events over 90 days despite real leads
// existing. It's now sent server-side via GA4 Measurement Protocol, right
// after the DB insert actually succeeds (see ../actions.ts and
// ../submit-lead-flow.ts) — one mechanism, not two, and tied to a real
// successful lead rather than to this page merely rendering (which could
// also double-fire on a refresh/back-navigation, unlike the server-side call).
export default function ThankYouPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-2xl font-semibold">Thank you</h1>
      <p className="text-neutral-500 dark:text-neutral-400">
        We&apos;ve received your request and will be in touch shortly.
      </p>
      <Link href="/" className="mt-2 text-sm underline">
        Back to home
      </Link>
    </main>
  );
}
