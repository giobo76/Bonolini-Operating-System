"use client";

import { useEffect } from "react";
// Imported from this specific subpath, not the @bos/core root barrel:
// the root barrel re-exports the whole marketing/clients surface, which
// transitively pulls in @bos/auth's next/headers-using server client — that
// broke the transfer-web client bundle (a "use client" component can't
// import a package that imports next/headers). attribution.ts itself is
// pure, dependency-free logic, so a dedicated subpath export (see
// packages/core/package.json) sidesteps the whole barrel instead.
import { buildAttributionCookieValue } from "@bos/core/clients/attribution";

// Runs on every page this app serves (mounted once, in layout.tsx) — the
// "capture at arrival" half of the attribution fix. Real Production data
// (2026-08-28) showed 28/28 recent leads with zero gclid/utm/landing_page:
// the old code only ever looked at /request-quote's own URL, and visitors
// reach it via a plain internal link with no query string. This writes a
// first-party cookie the moment a page's URL actually carries tracking
// data, so it survives whatever navigation happens next within this app.
//
// 90-day cookie lifetime reuses Google Ads' own default click-through
// conversion window (not an invented number) as the "how long should a
// touch still count" horizon.
const COOKIE_NAME = "bos_attribution";
const COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export function AttributionCapture() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const value = buildAttributionCookieValue(
      {
        utmSource: params.get("utm_source") ?? undefined,
        utmMedium: params.get("utm_medium") ?? undefined,
        utmCampaign: params.get("utm_campaign") ?? undefined,
        utmTerm: params.get("utm_term") ?? undefined,
        utmContent: params.get("utm_content") ?? undefined,
        gclid: params.get("gclid") ?? undefined,
      },
      window.location.pathname,
    );

    // null means this page's URL carried no tracking param at all — leave
    // any existing cookie completely untouched (see buildAttributionCookieValue).
    if (value === null) return;

    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  }, []);

  return null;
}
