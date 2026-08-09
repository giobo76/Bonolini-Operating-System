import Link from "next/link";
import Script from "next/script";

export default function ThankYouPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8 text-center">
      {/* Only reached after a successful lead submission (see ../actions.ts),
          so this fires exactly once per real lead — no dedup needed. This
          is the GA4 event packages/core/src/marketing/checks/ga4-checks.ts
          checks for under "conversion_tracking". */}
      <Script id="lead-conversion-event" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || []; window.dataLayer.push({ event: "generate_lead" });`}
      </Script>
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
