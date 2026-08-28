// Server-side GA4 event sending (Measurement Protocol), used specifically
// for the request-quote lead flow's "generate_lead" event.
//
// Why not GTM (the project's normal tracking mechanism): a real, read-only
// investigation of the live, published GTM container (GTM-58GJWMF7,
// version 37, 2026-08-28) found it has WhatsApp/phone/email click tracking
// already correctly configured (linkClick triggers + GA4 + Google Ads
// conversion tags — a real, working system, left untouched here) but NO
// trigger or tag of any kind reacting to a "generate_lead" custom event —
// the client-side dataLayer.push this app used to do on the thank-you page
// had, provably, nowhere to go. Creating that trigger/tag would require
// writing to that shared, live container; the connected OAuth token only
// carries tagmanager.readonly (verified via token introspection), so this
// app cannot do that write even if it were the right call — and unilaterally
// modifying a real business's live tag config, sight unseen by the founder,
// is not a call to make without them. Sending the event server-side instead
// avoids touching that container at all, and — as a bonus — ties emission
// directly to a real successful DB insert rather than to a client-side
// script that may or may not run (ad blockers, consent tools, refreshes).
//
// GA4_MEASUREMENT_ID is the property's data stream ID (confirmed from the
// same container: tag "Tag Google G-S73ZJMCDVL" — that literal value).
// GA4_MEASUREMENT_PROTOCOL_API_SECRET does not exist yet anywhere in this
// project and cannot be created via the existing OAuth connection either
// (analytics.readonly only, verified) — it must be created once, manually,
// in GA4 Admin -> Data Streams -> that stream -> Measurement Protocol API
// secrets, and set as this env var. Until then this fails soft (see below).

export interface Ga4ConversionEventInput {
  // GA4's own anonymous per-visitor id (the numeric portion of the `_ga`
  // cookie) — see resolveGa4ClientId. Deliberately not this app's own
  // `clients.id`; conflating the two would misrepresent whose identifier
  // this is to GA4.
  clientId: string;
  eventName: string;
}

export interface Ga4ConversionEventResult {
  sent: boolean;
  reason?: string;
}

export async function sendGa4ConversionEvent(input: Ga4ConversionEventInput): Promise<Ga4ConversionEventResult> {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_MEASUREMENT_PROTOCOL_API_SECRET;

  if (!measurementId || !apiSecret) {
    return { sent: false, reason: "GA4_MEASUREMENT_ID or GA4_MEASUREMENT_PROTOCOL_API_SECRET is not set" };
  }

  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify({
      client_id: input.clientId,
      // No `value`/`currency` params — this project has no real per-lead
      // revenue figure to attach (see docs/domain: no booking-value system
      // exists yet), and inventing one would be exactly the fabricated
      // financial data the founder has repeatedly ruled out.
      events: [{ name: input.eventName, params: {} }],
    }),
  });

  return { sent: response.ok, reason: response.ok ? undefined : `HTTP ${response.status}` };
}

// Thin, named wrapper for the one event this project actually needs today
// — kept separate from the generic sender so call sites read as intent
// ("track a lead conversion"), not as a raw API call, and so EXPECTED_EVENTS
// in ga4-checks.ts and this call site both name literally "generate_lead",
// not two independently-typed string literals that could drift apart.
export async function trackLeadConversion(gaClientId: string): Promise<Ga4ConversionEventResult> {
  return sendGa4ConversionEvent({ clientId: gaClientId, eventName: "generate_lead" });
}

// GA4's own `_ga` cookie (set by gtag.js/GTM, format "GA1.1.<client_id>"
// where client_id itself is two dot-joined numbers) carries the real
// per-visitor id GA4 already uses for this browsing session — reusing it
// lets a server-side event merge into the same GA4 user/session as
// whatever this visitor's browser-side hits already recorded, instead of
// registering as an unrelated new user. Falls back to a fresh random id
// (still a valid, acceptable Measurement Protocol client_id) when the
// cookie is absent — cookies disabled, consent declined, or GTM not having
// loaded on this particular visit — so the event still gets recorded
// rather than silently dropped; it just won't merge into that visitor's
// existing GA4 session. That tradeoff is disclosed, not hidden.
const GA_COOKIE_PATTERN = /^GA1\.\d+\.(\d+\.\d+)$/;

export function resolveGa4ClientId(gaCookieValue: string | undefined, randomFallback: () => string): string {
  if (gaCookieValue) {
    const match = GA_COOKIE_PATTERN.exec(gaCookieValue);
    if (match) return match[1]!;
  }
  return randomFallback();
}
