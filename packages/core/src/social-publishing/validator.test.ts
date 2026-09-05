import { describe, expect, it } from "vitest";
import {
  validatePost,
  validatePostForbiddenContent,
  validatePostHasCta,
  validatePostLanguage,
  validatePostLength,
} from "./validator";
import type { RealPostDataSnapshot } from "./content-source";

function snapshot(overrides: Partial<RealPostDataSnapshot> = {}): RealPostDataSnapshot {
  return {
    servedRoutes: [{ pickup: "Milano", destination: "Tirano" }],
    transferTypes: ["regional transfer"],
    serviceAreaPlaces: ["Milano", "Tirano"],
    windowDays: 90,
    ...overrides,
  };
}

const VALID_POST =
  "Every week we connect travelers across Lombardy and the Alps, from Milano to Tirano and beyond. " +
  "Whether it's a regional transfer or an airport run, our drivers know these roads well. " +
  "Planning a trip through the region? Get in touch to book your transfer.";

describe("validatePostLength", () => {
  it("rejects a post shorter than the minimum", () => {
    expect(validatePostLength("Too short.")).toMatch(/too short/);
  });

  it("rejects a post longer than the maximum", () => {
    expect(validatePostLength("a".repeat(3001))).toMatch(/too long/);
  });

  it("accepts a post within bounds", () => {
    expect(validatePostLength(VALID_POST)).toBeNull();
  });
});

describe("validatePostHasCta", () => {
  it("rejects a post with no call-to-action", () => {
    expect(validatePostHasCta("We serve many routes across the region every week without exception.")).toMatch(
      /no recognizable call-to-action/,
    );
  });

  it.each(["contact us today", "book your transfer", "message us on WhatsApp", "reach out anytime", "get in touch"])(
    "accepts a post containing the CTA phrase %s",
    (cta) => {
      expect(validatePostHasCta(`Some real content about our routes. ${cta}.`)).toBeNull();
    },
  );
});

describe("validatePostForbiddenContent", () => {
  it("flags an email address", () => {
    expect(validatePostForbiddenContent("Contact us at info@example.com to book.")).toEqual([
      expect.stringContaining("email address"),
    ]);
  });

  it("flags a phone-like number", () => {
    expect(validatePostForbiddenContent("Call us now at +39 333 1234567 to book.")).toEqual([
      expect.stringContaining("phone-like number"),
    ]);
  });

  it("flags a currency amount", () => {
    expect(validatePostForbiddenContent("Transfers starting from €390, get in touch.")).toEqual([
      expect.stringContaining("currency amount"),
    ]);
  });

  it("flags a placeholder marker", () => {
    expect(validatePostForbiddenContent("Book your transfer to [insert destination] today.")).toEqual([
      expect.stringContaining("placeholder marker"),
    ]);
  });

  it("flags an invented testimonial/rating claim", () => {
    expect(validatePostForbiddenContent("Our customers leave 5-star reviews every week, get in touch.")).toEqual(
      expect.arrayContaining([expect.stringContaining("invented testimonial/rating claim")]),
    );
  });

  it("flags an invented business-volume claim", () => {
    expect(validatePostForbiddenContent("We've served 500 customers this year, get in touch.")).toEqual(
      expect.arrayContaining([expect.stringContaining("business volume claim")]),
    );
  });

  it("returns no errors for clean, grounded content", () => {
    expect(validatePostForbiddenContent(VALID_POST)).toEqual([]);
  });
});

describe("validatePostLanguage", () => {
  it("flags a post written in Italian", () => {
    const italian =
      "Ogni settimana colleghiamo il territorio da Milano a Tirano con i nostri autisti per il servizio transfer.";
    expect(validatePostLanguage(italian)).toMatch(/Italian, not English/);
  });

  it("does not flag genuine English content", () => {
    expect(validatePostLanguage(VALID_POST)).toBeNull();
  });
});

describe("validatePost", () => {
  it("passes a well-formed, grounded English post", () => {
    const result = validatePost(VALID_POST, snapshot());
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("fails when the data snapshot has no real served routes, even if the text looks fine", () => {
    const result = validatePost(VALID_POST, snapshot({ servedRoutes: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("no real served routes")]));
  });

  it("aggregates multiple independent failures at once", () => {
    const result = validatePost("Too short and no cta.", snapshot());
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});
