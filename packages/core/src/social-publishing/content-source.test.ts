import { describe, expect, it, vi } from "vitest";

// @bos/db fully mocked, keyed by table identity — same strategy as
// marketing/business-kpis.test.ts. insert deliberately throws: this proves
// getRealPostDataSnapshot is structurally read-only, not just read-only by
// convention.
const { fakeState, bookingsTable } = vi.hoisted(() => {
  return {
    fakeState: {
      rows: [] as Array<{ pickup: string | null; destination: string | null }>,
    },
    bookingsTable: { __name: "bookings", pickup: "pickup", destination: "destination" },
  };
});

vi.mock("@bos/db", () => ({
  bookings: bookingsTable,
  getDb: () => ({
    select: () => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => (table === bookingsTable ? Promise.resolve(fakeState.rows) : Promise.resolve([])),
      }),
    }),
    insert: () => {
      throw new Error("content-source must never write — insert() should not be called");
    },
  }),
}));

const { getRealPostDataSnapshot, hasEnoughDataForPost, classifyTransferType } = await import("./content-source");

describe("classifyTransferType", () => {
  it("classifies a route touching a known airport as an airport transfer", () => {
    expect(classifyTransferType("Milano Malpensa", "Sondrio")).toBe("airport transfer");
    expect(classifyTransferType("Bergamo Airport", "Tirano")).toBe("airport transfer");
  });

  it("classifies a route between two non-airport places as a regional transfer", () => {
    expect(classifyTransferType("Milano", "Tirano")).toBe("regional transfer");
  });

  it("is case-insensitive", () => {
    expect(classifyTransferType("MALPENSA", "sondrio")).toBe("airport transfer");
  });
});

describe("getRealPostDataSnapshot", () => {
  it("returns an empty snapshot when there are no eligible bookings", async () => {
    fakeState.rows = [];

    const snapshot = await getRealPostDataSnapshot("tenant-1");

    expect(snapshot.servedRoutes).toEqual([]);
    expect(snapshot.transferTypes).toEqual([]);
    expect(snapshot.serviceAreaPlaces).toEqual([]);
  });

  it("deduplicates identical routes, never counting the same pickup->destination pair twice", async () => {
    fakeState.rows = [
      { pickup: "Milano", destination: "Tirano" },
      { pickup: "Milano", destination: "Tirano" },
      { pickup: "Milano", destination: "Bormio" },
    ];

    const snapshot = await getRealPostDataSnapshot("tenant-1");

    expect(snapshot.servedRoutes).toEqual([
      { pickup: "Milano", destination: "Tirano" },
      { pickup: "Milano", destination: "Bormio" },
    ]);
  });

  it("never invents a route from a row with a null pickup or destination", async () => {
    fakeState.rows = [
      { pickup: "Milano", destination: null },
      { pickup: null, destination: "Tirano" },
      { pickup: "Milano", destination: "Tirano" },
    ];

    const snapshot = await getRealPostDataSnapshot("tenant-1");

    expect(snapshot.servedRoutes).toEqual([{ pickup: "Milano", destination: "Tirano" }]);
  });

  it("collects a deduplicated, sorted set of every place seen across routes", async () => {
    fakeState.rows = [
      { pickup: "Tirano", destination: "Milano" },
      { pickup: "Milano", destination: "Bormio" },
    ];

    const snapshot = await getRealPostDataSnapshot("tenant-1");

    expect(snapshot.serviceAreaPlaces).toEqual(["Bormio", "Milano", "Tirano"]);
  });

  it("collects the deduplicated set of transfer types actually observed", async () => {
    fakeState.rows = [
      { pickup: "Milano Malpensa", destination: "Sondrio" },
      { pickup: "Milano", destination: "Tirano" },
    ];

    const snapshot = await getRealPostDataSnapshot("tenant-1");

    expect(snapshot.transferTypes.sort()).toEqual(["airport transfer", "regional transfer"]);
  });
});

describe("hasEnoughDataForPost", () => {
  it("is false when there are no served routes", () => {
    expect(hasEnoughDataForPost({ servedRoutes: [], transferTypes: [], serviceAreaPlaces: [], windowDays: 90 })).toBe(
      false,
    );
  });

  it("is true when at least one real served route exists", () => {
    expect(
      hasEnoughDataForPost({
        servedRoutes: [{ pickup: "Milano", destination: "Tirano" }],
        transferTypes: ["regional transfer"],
        serviceAreaPlaces: ["Milano", "Tirano"],
        windowDays: 90,
      }),
    ).toBe(true);
  });
});
