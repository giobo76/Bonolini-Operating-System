import { describe, expect, it } from "vitest";
import { computeBusyWindow, findOverlaps, findRouteMinimum, windowsOverlap } from "./busy-window";

// Founder decisions 2026-09-25: event = the whole busy time (Sondrio ->
// pickup -> destination -> Sondrio), Malpensa minimum 5 hours as a Business
// Rule, 2 hours + "Durata da verificare" without Google Maps.

const MALPENSA_RULE = {
  minimums: [{ label: "Malpensa", placeKeywords: ["malpensa", "mxp"], minimumMinutes: 300 }],
};

const PICKUP_AT = new Date("2026-10-03T12:30:00.000Z"); // 14:30 in Rome

describe("findRouteMinimum", () => {
  it("Malpensa in either direction, and MXP", () => {
    expect(findRouteMinimum(MALPENSA_RULE, "Sondrio", "Malpensa")).toEqual({ label: "Malpensa", minutes: 300 });
    expect(findRouteMinimum(MALPENSA_RULE, "Aeroporto di Milano Malpensa T1", "Via Roma 1, Sondrio")).toEqual({
      label: "Malpensa",
      minutes: 300,
    });
    expect(findRouteMinimum(MALPENSA_RULE, "MXP", "Livigno")?.minutes).toBe(300);
  });

  it("no minimum for other routes, or without the rule", () => {
    expect(findRouteMinimum(MALPENSA_RULE, "Linate", "Sondrio")).toBeNull();
    expect(findRouteMinimum(null, "Malpensa", "Sondrio")).toBeNull();
  });

  it("the largest matching minimum wins", () => {
    const rule = {
      minimums: [
        { label: "Malpensa", placeKeywords: ["malpensa"], minimumMinutes: 300 },
        { label: "Livigno", placeKeywords: ["livigno"], minimumMinutes: 360 },
      ],
    };
    expect(findRouteMinimum(rule, "Malpensa", "Livigno")).toEqual({ label: "Livigno", minutes: 360 });
  });
});

describe("computeBusyWindow", () => {
  it("starts when the founder leaves Sondrio and lasts the whole loop", () => {
    const window = computeBusyWindow({
      pickupAt: PICKUP_AT,
      loopMinutes: 270,
      minutesBeforePickup: 130,
      minimum: null,
      minimumRuleInvalid: false,
    });
    expect(window.startAt.toISOString()).toBe("2026-10-03T10:20:00.000Z");
    expect(window.endAt.toISOString()).toBe("2026-10-03T14:50:00.000Z");
    expect(window.durationToVerify).toBe(false);
    expect(window.minimumApplied).toBeNull();
  });

  it("Malpensa: a shorter loop is extended to the 5-hour minimum", () => {
    const window = computeBusyWindow({
      pickupAt: PICKUP_AT,
      loopMinutes: 260,
      minutesBeforePickup: 0,
      minimum: { label: "Malpensa", minutes: 300 },
      minimumRuleInvalid: false,
    });
    expect(window.startAt.toISOString()).toBe("2026-10-03T12:30:00.000Z");
    expect(window.endAt.toISOString()).toBe("2026-10-03T17:30:00.000Z");
    expect(window.minimumApplied).toEqual({ label: "Malpensa", minutes: 300 });
  });

  it("a loop longer than the minimum keeps its own duration", () => {
    const window = computeBusyWindow({
      pickupAt: PICKUP_AT,
      loopMinutes: 330,
      minutesBeforePickup: 0,
      minimum: { label: "Malpensa", minutes: 300 },
      minimumRuleInvalid: false,
    });
    expect(window.endAt.toISOString()).toBe("2026-10-03T18:00:00.000Z");
    expect(window.minimumApplied).toBeNull();
  });

  it("without Google Maps: from the pickup time, 2 hours, to be checked", () => {
    const window = computeBusyWindow({
      pickupAt: PICKUP_AT,
      loopMinutes: null,
      minutesBeforePickup: null,
      minimum: null,
      minimumRuleInvalid: false,
    });
    expect(window.startAt.toISOString()).toBe("2026-10-03T12:30:00.000Z");
    expect(window.endAt.toISOString()).toBe("2026-10-03T14:30:00.000Z");
    expect(window.durationToVerify).toBe(true);
  });

  it("without Google Maps on a Malpensa route: never less than the minimum, still to be checked", () => {
    const window = computeBusyWindow({
      pickupAt: PICKUP_AT,
      loopMinutes: null,
      minutesBeforePickup: null,
      minimum: { label: "Malpensa", minutes: 300 },
      minimumRuleInvalid: false,
    });
    expect(window.endAt.toISOString()).toBe("2026-10-03T17:30:00.000Z");
    expect(window.durationToVerify).toBe(true);
  });

  it("rounds outward to 5 minutes, never shorter than the real busy time", () => {
    const window = computeBusyWindow({
      pickupAt: PICKUP_AT,
      loopMinutes: 101,
      minutesBeforePickup: 33,
      minimum: null,
      minimumRuleInvalid: false,
    });
    expect(window.startAt.toISOString()).toBe("2026-10-03T11:55:00.000Z");
    expect(window.endAt.toISOString()).toBe("2026-10-03T13:40:00.000Z");
  });

  it("an unreadable minimum rule makes the duration to be checked", () => {
    const window = computeBusyWindow({
      pickupAt: PICKUP_AT,
      loopMinutes: 270,
      minutesBeforePickup: 130,
      minimum: null,
      minimumRuleInvalid: true,
    });
    expect(window.durationToVerify).toBe(true);
  });
});

// Founder decisions 2026-09-26: overlap = one window starts before the
// other ends; back-to-back services are flagged too (each window includes
// the return to Sondrio), touching windows are not.
describe("windowsOverlap / findOverlaps", () => {
  const w = (start: string, end: string) => ({ startAt: new Date(start), endAt: new Date(end) });

  it("overlapping, contained and identical windows overlap", () => {
    expect(windowsOverlap(w("2026-10-03T10:00Z", "2026-10-03T14:00Z"), w("2026-10-03T13:00Z", "2026-10-03T16:00Z"))).toBe(true);
    expect(windowsOverlap(w("2026-10-03T10:00Z", "2026-10-03T18:00Z"), w("2026-10-03T12:00Z", "2026-10-03T13:00Z"))).toBe(true);
    expect(windowsOverlap(w("2026-10-03T10:00Z", "2026-10-03T12:00Z"), w("2026-10-03T10:00Z", "2026-10-03T12:00Z"))).toBe(true);
  });

  it("touching or separate windows do not overlap", () => {
    expect(windowsOverlap(w("2026-10-03T10:00Z", "2026-10-03T12:00Z"), w("2026-10-03T12:00Z", "2026-10-03T14:00Z"))).toBe(false);
    expect(windowsOverlap(w("2026-10-03T10:00Z", "2026-10-03T12:00Z"), w("2026-10-03T15:00Z", "2026-10-03T16:00Z"))).toBe(false);
  });

  it("across midnight", () => {
    expect(windowsOverlap(w("2026-10-03T21:00Z", "2026-10-04T02:00Z"), w("2026-10-04T01:00Z", "2026-10-04T03:00Z"))).toBe(true);
  });

  it("findOverlaps returns only the overlapping ones, in time order", () => {
    const candidate = w("2026-10-03T10:00Z", "2026-10-03T15:00Z");
    const found = findOverlaps(candidate, [
      { id: "late", ...w("2026-10-03T14:00Z", "2026-10-03T16:00Z") },
      { id: "far", ...w("2026-10-04T10:00Z", "2026-10-04T12:00Z") },
      { id: "early", ...w("2026-10-03T08:00Z", "2026-10-03T11:00Z") },
    ]);
    expect(found.map((item) => item.id)).toEqual(["early", "late"]);
  });
});
