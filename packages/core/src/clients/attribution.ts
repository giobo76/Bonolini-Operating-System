// First-touch marketing attribution for the request-quote lead flow.
//
// Root cause (verified against real Production data, 2026-08-28): the old
// RequestQuotePage read gclid/utm_*/landingPage directly from ITS OWN URL's
// searchParams, and hardcoded landingPage to "/request-quote". Real Google
// Ads traffic lands on content pages outside this app entirely (see
// MARKETING_MONITORED_URLS — bonolinitransfer.com/en/milan-to-tirano-
// transfer/ etc., not part of this Next.js app), and visitors reach
// /request-quote via a plain internal link carrying no query string at all.
// The moment a visitor left the landing page, every tracking parameter was
// gone — nothing on the page ever wrote it down anywhere. Real Production
// clients rows confirm this: 28/28 recent leads had gclid, utm_source, and
// landing_page all null. This module is the fix: capture on arrival at
// ANY page this app serves, persist across navigation, resolve at submit
// time — never inventing data, never silently discarding real data.

export interface AttributionFields {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  gclid?: string;
  landingPage?: string;
}

// What the client-side capture script persists into the `bos_attribution`
// cookie. Deliberately the same field shape as AttributionFields — no
// translation layer to get wrong between write and read.
export type AttributionCookiePayload = AttributionFields;

function hasAnyTrackingParam(fields: {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  gclid?: string;
}): boolean {
  return Boolean(
    fields.utmSource || fields.utmMedium || fields.utmCampaign || fields.utmTerm || fields.utmContent || fields.gclid,
  );
}

// Called client-side, on every page, with the CURRENT page's own URL
// params and pathname. Returns null when there is nothing worth writing —
// the caller (attribution-capture.tsx) must then leave any existing cookie
// completely untouched. This is the literal mechanism behind "non
// sovrascriva dati di attribuzione validi con valori vuoti": a page visit
// with no tracking params in its URL never calls document.cookie at all.
export function buildAttributionCookieValue(
  params: {
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmTerm?: string;
    utmContent?: string;
    gclid?: string;
  },
  pathname: string,
): string | null {
  if (!hasAnyTrackingParam(params)) return null;

  const payload: AttributionCookiePayload = {
    utmSource: params.utmSource || undefined,
    utmMedium: params.utmMedium || undefined,
    utmCampaign: params.utmCampaign || undefined,
    utmTerm: params.utmTerm || undefined,
    utmContent: params.utmContent || undefined,
    gclid: params.gclid || undefined,
    landingPage: pathname,
  };
  return JSON.stringify(payload);
}

// Parses the raw cookie string read server-side. Never throws — a
// malformed or tampered cookie value degrades to "no cookie", not a
// crashed page; the caller falls back to resolveAttribution's other
// sources exactly as if the cookie had never been set.
export function parseAttributionCookie(raw: string | undefined): AttributionCookiePayload | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const asString = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
    return {
      utmSource: asString(record.utmSource),
      utmMedium: asString(record.utmMedium),
      utmCampaign: asString(record.utmCampaign),
      utmTerm: asString(record.utmTerm),
      utmContent: asString(record.utmContent),
      gclid: asString(record.gclid),
      landingPage: asString(record.landingPage),
    };
  } catch {
    return null;
  }
}

// The single source of truth for "what attribution do we submit with this
// lead", called server-side when /request-quote renders. Priority:
// 1. The bos_attribution cookie, if it carries any real tracking data —
//    this is what survives navigation from wherever the visitor actually
//    arrived (this app's homepage, or any future page) through to the
//    form, satisfying "mantenga questi dati durante la navigazione".
// 2. The current page's own URL params — covers a Google Ads final URL
//    that points directly at /request-quote?... with no intermediate hop
//    (the client-side cookie-writer hasn't run yet on this exact request).
// 3. Neither — a genuinely organic/direct/referral visitor. Returns just
//    the landing page with everything else undefined; the lead remains
//    fully valid (leadSubmissionSchema treats every attribution field as
//    optional) rather than being blocked or backfilled with invented data.
export function resolveAttribution(
  cookie: AttributionCookiePayload | null,
  currentPageParams: {
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmTerm?: string;
    utmContent?: string;
    gclid?: string;
  },
  currentPathname: string,
): AttributionFields {
  if (cookie && hasAnyTrackingParam(cookie)) {
    return {
      utmSource: cookie.utmSource,
      utmMedium: cookie.utmMedium,
      utmCampaign: cookie.utmCampaign,
      utmTerm: cookie.utmTerm,
      utmContent: cookie.utmContent,
      gclid: cookie.gclid,
      landingPage: cookie.landingPage || currentPathname,
    };
  }

  if (hasAnyTrackingParam(currentPageParams)) {
    return {
      utmSource: currentPageParams.utmSource || undefined,
      utmMedium: currentPageParams.utmMedium || undefined,
      utmCampaign: currentPageParams.utmCampaign || undefined,
      utmTerm: currentPageParams.utmTerm || undefined,
      utmContent: currentPageParams.utmContent || undefined,
      gclid: currentPageParams.gclid || undefined,
      landingPage: currentPathname,
    };
  }

  return { landingPage: currentPathname };
}
