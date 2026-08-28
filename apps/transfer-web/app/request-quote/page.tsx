import { cookies } from "next/headers";
import { parseAttributionCookie, resolveAttribution } from "@bos/core";
import { submitLeadAction } from "./actions";

function getParam(
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const value = searchParams[key];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function RequestQuotePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const errorMessage = getParam(sp, "error");

  // Root-cause fix (see packages/core/src/clients/attribution.ts): prefer
  // the bos_attribution cookie written on arrival at whichever page of this
  // app the visitor actually landed on — it's what survives navigation
  // through to this form. Falls back to this exact page's own URL params
  // (an ad's final URL pointing straight at /request-quote), then to
  // "no attribution, still a valid lead" if neither exists.
  const cookieStore = await cookies();
  const cookie = parseAttributionCookie(cookieStore.get("bos_attribution")?.value);
  const attribution = resolveAttribution(
    cookie,
    {
      utmSource: getParam(sp, "utm_source") || undefined,
      utmMedium: getParam(sp, "utm_medium") || undefined,
      utmCampaign: getParam(sp, "utm_campaign") || undefined,
      utmTerm: getParam(sp, "utm_term") || undefined,
      utmContent: getParam(sp, "utm_content") || undefined,
      gclid: getParam(sp, "gclid") || undefined,
    },
    "/request-quote",
  );

  const utmSource = attribution.utmSource ?? "";
  const utmMedium = attribution.utmMedium ?? "";
  const utmCampaign = attribution.utmCampaign ?? "";
  const utmTerm = attribution.utmTerm ?? "";
  const utmContent = attribution.utmContent ?? "";
  const gclid = attribution.gclid ?? "";
  const landingPage = attribution.landingPage ?? "/request-quote";

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Request a Quote</h1>
        <p className="text-neutral-500 dark:text-neutral-400">
          Tell us about your trip and we&apos;ll get back to you.
        </p>
      </div>

      {errorMessage ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {errorMessage}
        </p>
      ) : null}

      <form action={submitLeadAction} className="space-y-4">
        <input type="hidden" name="utmSource" value={utmSource} />
        <input type="hidden" name="utmMedium" value={utmMedium} />
        <input type="hidden" name="utmCampaign" value={utmCampaign} />
        <input type="hidden" name="utmTerm" value={utmTerm} />
        <input type="hidden" name="utmContent" value={utmContent} />
        <input type="hidden" name="gclid" value={gclid} />
        <input type="hidden" name="landingPage" value={landingPage} />

        <div>
          <label className="mb-1 block text-sm font-medium">Full name *</label>
          <input
            type="text"
            name="fullName"
            required
            className="w-full rounded border px-3 py-2"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Phone *</label>
            <input
              type="tel"
              name="phone"
              required
              className="w-full rounded border px-3 py-2"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Email</label>
            <input type="email" name="email" className="w-full rounded border px-3 py-2" />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">
            Tell us about your trip
          </label>
          <textarea
            name="message"
            rows={4}
            placeholder="Pickup, drop-off, date/time, passengers…"
            className="w-full rounded border px-3 py-2"
          />
        </div>
        <button
          type="submit"
          className="w-full rounded bg-neutral-900 px-3 py-2 text-white"
        >
          Request a Quote
        </button>
      </form>
    </main>
  );
}
