import { describe, expect, it } from "vitest";
import { buildAttributionCookieValue, parseAttributionCookie, resolveAttribution } from "./attribution";

describe("buildAttributionCookieValue", () => {
  it("returns null when the current URL carries no tracking param — never overwrites an existing cookie with blanks", () => {
    expect(buildAttributionCookieValue({}, "/")).toBeNull();
  });

  it("builds a cookie value when gclid is present", () => {
    const value = buildAttributionCookieValue({ gclid: "Cj0abc123" }, "/en/milan-to-tirano-transfer/");
    expect(JSON.parse(value!)).toMatchObject({ gclid: "Cj0abc123", landingPage: "/en/milan-to-tirano-transfer/" });
  });

  it("builds a cookie value when only UTM params are present (no gclid — organic/social campaign link)", () => {
    const value = buildAttributionCookieValue({ utmSource: "facebook", utmMedium: "social", utmCampaign: "summer" }, "/");
    expect(JSON.parse(value!)).toMatchObject({ utmSource: "facebook", utmMedium: "social", utmCampaign: "summer" });
  });
});

describe("parseAttributionCookie", () => {
  it("returns null for an absent cookie", () => {
    expect(parseAttributionCookie(undefined)).toBeNull();
  });

  it("returns null for a malformed/tampered cookie value instead of throwing", () => {
    expect(parseAttributionCookie("not json {{{")).toBeNull();
    expect(parseAttributionCookie("null")).toBeNull();
    expect(parseAttributionCookie('"just a string"')).toBeNull();
  });

  it("parses a real cookie value back into its fields", () => {
    const raw = JSON.stringify({ gclid: "Cj0abc123", utmSource: "google", landingPage: "/en/milan-to-tirano-transfer/" });
    expect(parseAttributionCookie(raw)).toMatchObject({
      gclid: "Cj0abc123",
      utmSource: "google",
      landingPage: "/en/milan-to-tirano-transfer/",
    });
  });
});

describe("resolveAttribution", () => {
  // FASE 5, test 1: URL con gclid -> gclid arriva al lead (no cookie yet —
  // the ad's final URL points directly at /request-quote).
  it("1: a gclid on the current page's own URL is used when there is no cookie yet", () => {
    const result = resolveAttribution(null, { gclid: "Cj0xyz" }, "/request-quote");
    expect(result.gclid).toBe("Cj0xyz");
  });

  // FASE 5, test 2: URL con UTM -> UTM arrivano al lead.
  it("2: UTM params on the current page's own URL are used when there is no cookie yet", () => {
    const result = resolveAttribution(
      null,
      { utmSource: "google", utmMedium: "cpc", utmCampaign: "malpensa-core", utmTerm: "ncc sondrio" },
      "/request-quote",
    );
    expect(result).toMatchObject({ utmSource: "google", utmMedium: "cpc", utmCampaign: "malpensa-core", utmTerm: "ncc sondrio" });
  });

  // FASE 5, test 3: landing page viene conservata (the real first page the
  // visitor arrived on, not wherever the form happens to live).
  it("3: the cookie's original landing page is preserved, not overwritten by the current page's path", () => {
    const cookie = { gclid: "Cj0xyz", landingPage: "/en/milan-to-tirano-transfer/" };
    const result = resolveAttribution(cookie, {}, "/request-quote");
    expect(result.landingPage).toBe("/en/milan-to-tirano-transfer/");
  });

  // FASE 5, test 4: navigazione intermedia non perde l'attribuzione — the
  // visitor landed with real tracking data (now in the cookie), then
  // browsed to a page with no params at all, then reached the form.
  it("4: cookie data survives even when the current page's own URL has no tracking params at all", () => {
    const cookie = { gclid: "Cj0xyz", utmSource: "google", utmMedium: "cpc", landingPage: "/" };
    const result = resolveAttribution(cookie, {}, "/request-quote");
    expect(result).toMatchObject({ gclid: "Cj0xyz", utmSource: "google", utmMedium: "cpc", landingPage: "/" });
  });

  // FASE 5, test 5: valori vuoti non sovrascrivono valori validi — a cookie
  // with real data takes priority over the current page's empty params
  // (this is the read-side of the same guarantee buildAttributionCookieValue
  // enforces on the write side).
  it("5: real cookie data is never displaced by the current page's empty params", () => {
    const cookie = { gclid: "Cj0real", landingPage: "/" };
    const result = resolveAttribution(cookie, { gclid: undefined, utmSource: undefined }, "/request-quote");
    expect(result.gclid).toBe("Cj0real");
  });

  // FASE 5, test 6: lead senza attribuzione continua a funzionare — no
  // cookie, no URL params: a genuinely organic/direct visitor.
  it("6: an organic/direct visitor with no tracking data anywhere still resolves to a valid (if empty) attribution", () => {
    const result = resolveAttribution(null, {}, "/request-quote");
    expect(result).toEqual({ landingPage: "/request-quote" });
  });

  it("prefers the cookie over the current page's URL params when both are present (cookie represents the real first touch)", () => {
    const cookie = { gclid: "Cj0first-touch", landingPage: "/en/milan-to-tirano-transfer/" };
    const result = resolveAttribution(cookie, { gclid: "Cj0different-later-click" }, "/request-quote");
    expect(result.gclid).toBe("Cj0first-touch");
  });
});
