import { describe, expect, it } from "vitest";
import { toValidDate } from "./dates";

describe("toValidDate", () => {
  it("reads timestamptz exactly as postgres-js returns it through raw SQL", () => {
    expect(toValidDate("2026-09-24 10:15:30.123+00")?.toISOString()).toBe("2026-09-24T10:15:30.123Z");
    expect(toValidDate("2026-09-24 10:15:30+00")?.toISOString()).toBe("2026-09-24T10:15:30.000Z");
    expect(toValidDate("2026-09-24 12:15:30.123456+02")?.toISOString()).toBe("2026-09-24T10:15:30.123Z");
    expect(toValidDate("2026-09-24 12:15:30+02:00")?.toISOString()).toBe("2026-09-24T10:15:30.000Z");
    expect(toValidDate("2026-09-24 05:45:30+0530")?.toISOString()).toBe("2026-09-24T00:15:30.000Z");
  });

  it("reads ISO strings and passes real Dates through", () => {
    expect(toValidDate("2026-09-24T10:15:30.123Z")?.toISOString()).toBe("2026-09-24T10:15:30.123Z");
    const date = new Date("2026-09-24T10:15:30.123Z");
    expect(toValidDate(date)).toBe(date);
  });

  it("returns null, never an Invalid Date, for anything unreadable", () => {
    expect(toValidDate(null)).toBeNull();
    expect(toValidDate(undefined)).toBeNull();
    expect(toValidDate("")).toBeNull();
    expect(toValidDate("not a timestamp")).toBeNull();
    expect(toValidDate(new Date("nope"))).toBeNull();
    expect(toValidDate(1727172930000)).toBeNull();
  });
});
