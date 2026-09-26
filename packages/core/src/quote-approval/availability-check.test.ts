import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TransferRequest } from "@bos/db";

// runAvailabilityCheck with its sources mocked at their module boundary:
// Google Maps (the busy loop), the minimum-duration rule, the bookings and
// the Google Calendar events. Founder decisions 2026-09-26.

const state = vi.hoisted(() => ({
  loop: null as unknown,
  rule: null as unknown,
  bookings: [] as Array<Record<string, unknown>>,
  calendar: { status: "ok", events: [] } as unknown,
  bookingQueries: [] as Array<{ from: Date; to: Date }>,
  calendarQueries: [] as Array<{ from: Date; to: Date }>,
}));

vi.mock("../maps-distance", () => ({ calculateBusyLoopFromBase: async () => state.loop }));
vi.mock("../business-rules", () => ({ getBusinessRuleByKey: async () => state.rule }));
vi.mock("../bookings", () => ({
  listActiveBookingsBetween: async (_t: string, from: Date, to: Date) => {
    state.bookingQueries.push({ from, to });
    return state.bookings;
  },
}));
vi.mock("../calendar", async () => {
  const schema = await vi.importActual<typeof import("../calendar/schema")>("../calendar/schema");
  return {
    isBosEventId: schema.isBosEventId,
    listCalendarBusyEvents: async (_t: string, from: Date, to: Date) => {
      state.calendarQueries.push({ from, to });
      return state.calendar;
    },
  };
});
vi.mock("../clients", () => ({
  getClient: async (_t: string, id: string) => ({ id, fullName: id === "client-2" ? "Anna Bianchi" : "Mario Rossi" }),
}));

const { runAvailabilityCheck } = await import("./availability-check");

const TR = {
  id: "a1b2c3d4-0000-4000-8000-000000000001",
  pickup: "Malpensa",
  destination: "Sondrio",
  requestedDate: "2026-10-03",
  requestedTime: "14:30", // 12:30Z
} as TransferRequest;

function loop(totalMinutes: number, beforePickup: number) {
  return {
    status: "ok",
    provider: "google_routes_api",
    distanceKm: 300,
    durationMinutes: totalMinutes,
    minutesBeforePickup: beforePickup,
    legs: [
      { origin: "Sondrio", destination: "Malpensa", distanceKm: 150, durationMinutes: beforePickup },
      { origin: "Malpensa", destination: "Sondrio", distanceKm: 150, durationMinutes: totalMinutes - beforePickup },
    ],
    error: null,
  };
}

const MALPENSA_RULE = {
  id: "rule-1",
  versions: [
    {
      id: "v1",
      status: "effective",
      content: { minimums: [{ label: "Malpensa", placeKeywords: ["malpensa", "mxp"], minimumMinutes: 300 }] },
    },
  ],
};

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-2",
    clientId: "client-2",
    transferRequestId: "ffeeddcc-0000-4000-8000-000000000002",
    calendarEventId: null,
    status: "confirmed",
    pickup: "Sondrio",
    destination: "Linate",
    scheduledAt: new Date("2026-10-03T09:00:00.000Z"),
    busyWindow: null,
    ...overrides,
  };
}

beforeEach(() => {
  // 12:30Z pickup, 130 min before it: busy 10:20Z - 14:50Z (270 min), the
  // Malpensa minimum makes it 10:20Z - 15:20Z.
  state.loop = loop(270, 130);
  state.rule = MALPENSA_RULE;
  state.bookings = [];
  state.calendar = { status: "ok", events: [] };
  state.bookingQueries = [];
  state.calendarQueries = [];
});

describe("runAvailabilityCheck", () => {
  it("the request's busy window: Sondrio loop from Google Maps, Malpensa minimum, pickup read in Europe/Rome", async () => {
    const check = await runAvailabilityCheck("tenant-1", TR);

    expect(check.candidate).toMatchObject({
      startAt: "2026-10-03T10:20:00.000Z",
      endAt: "2026-10-03T15:20:00.000Z",
      minimumApplied: { label: "Malpensa", minutes: 300 },
      durationToVerify: false,
    });
    expect(state.calendarQueries[0]).toEqual({
      from: new Date("2026-10-03T10:20:00.000Z"),
      to: new Date("2026-10-03T15:20:00.000Z"),
    });
  });

  it("nothing around: free, calendar checked, no reason", async () => {
    const check = await runAvailabilityCheck("tenant-1", TR);
    expect(check.overlaps).toEqual([]);
    expect(check.calendarChecked).toBe(true);
    expect(check.notVerifiedReasons).toEqual([]);
  });

  it("a booking whose stored busy window overlaps is reported with its details", async () => {
    state.bookings = [
      booking({
        busyWindow: {
          startAt: "2026-10-03T08:30:00.000Z",
          endAt: "2026-10-03T11:00:00.000Z",
          durationToVerify: false,
          minimumApplied: null,
          loopLabel: "Sondrio → Linate → Sondrio",
          loopMinutes: 150,
          mapsUnavailable: false,
          minimumRuleInvalid: false,
        },
      }),
    ];

    const check = await runAvailabilityCheck("tenant-1", TR);

    expect(check.bookingsChecked).toBe(1);
    expect(check.overlaps).toEqual([
      {
        kind: "booking",
        startAt: "2026-10-03T08:30:00.000Z",
        endAt: "2026-10-03T11:00:00.000Z",
        durationToVerify: false,
        clientName: "Anna Bianchi",
        pickup: "Sondrio",
        destination: "Linate",
        pickupAt: "2026-10-03T09:00:00.000Z",
        bookingStatus: "confirmed",
        ref: "#ffeedd",
      },
    ]);
  });

  it("back-to-back services are flagged: the earlier one's return to Sondrio overlaps", async () => {
    state.bookings = [
      booking({
        destination: "Malpensa",
        busyWindow: {
          startAt: "2026-10-03T08:00:00.000Z",
          endAt: "2026-10-03T12:40:00.000Z",
          durationToVerify: false,
          minimumApplied: null,
          loopLabel: null,
          loopMinutes: 280,
          mapsUnavailable: false,
          minimumRuleInvalid: false,
        },
      }),
    ];
    const check = await runAvailabilityCheck("tenant-1", TR);
    expect(check.overlaps).toHaveLength(1);
  });

  it("a booking without a stored window counts as pickup + 2 hours, to verify", async () => {
    state.bookings = [booking({ scheduledAt: new Date("2026-10-03T14:00:00.000Z") })];

    const check = await runAvailabilityCheck("tenant-1", TR);

    expect(check.overlaps[0]).toMatchObject({
      startAt: "2026-10-03T14:00:00.000Z",
      endAt: "2026-10-03T16:00:00.000Z",
      durationToVerify: true,
    });
  });

  it("a booking that does not overlap is counted but not reported; the request's own booking is ignored", async () => {
    state.bookings = [
      booking({ scheduledAt: new Date("2026-10-03T18:00:00.000Z") }),
      booking({ id: "own", transferRequestId: TR.id, scheduledAt: new Date("2026-10-03T12:30:00.000Z") }),
    ];

    const check = await runAvailabilityCheck("tenant-1", TR);

    expect(check.bookingsChecked).toBe(1);
    expect(check.overlaps).toEqual([]);
  });

  it("calendar events that overlap are reported; a booking imported from Calendar is compared only through its event", async () => {
    state.bookings = [booking({ calendarEventId: "founder-evt-1", scheduledAt: new Date("2026-10-03T12:00:00.000Z") })];
    state.calendar = {
      status: "ok",
      events: [
        {
          id: "founder-evt-1",
          summary: "TRANSFER | Anna Bianchi | Sondrio → Linate",
          startAt: new Date("2026-10-03T12:00:00.000Z"),
          endAt: new Date("2026-10-03T13:00:00.000Z"),
          allDay: false,
        },
        {
          id: "dentista",
          summary: "Dentista",
          startAt: new Date("2026-10-03T14:00:00.000Z"),
          endAt: new Date("2026-10-03T15:00:00.000Z"),
          allDay: false,
        },
      ],
    };

    const check = await runAvailabilityCheck("tenant-1", TR);

    expect(check.overlaps.map((o) => o.kind)).toEqual(["calendar_event", "calendar_event"]);
    expect(check.overlaps.map((o) => o.summary)).toEqual(["TRANSFER | Anna Bianchi | Sondrio → Linate", "Dentista"]);
  });

  it("calendar not connected or unreadable: NOT verified with the reason, bookings still compared (imported ones too)", async () => {
    state.bookings = [booking({ calendarEventId: "founder-evt-1", scheduledAt: new Date("2026-10-03T12:00:00.000Z") })];
    state.calendar = { status: "not_connected" };
    let check = await runAvailabilityCheck("tenant-1", TR);
    expect(check.notVerifiedReasons).toEqual(["Google Calendar non collegato nel pannello"]);
    expect(check.calendarChecked).toBe(false);
    expect(check.overlaps).toHaveLength(1);

    state.calendar = { status: "error", message: "invalid_grant" };
    check = await runAvailabilityCheck("tenant-1", TR);
    expect(check.notVerifiedReasons).toEqual(["Google Calendar non leggibile: invalid_grant"]);
  });

  it("without Google Maps: 2 hours from pickup (5 on a Malpensa route), duration to verify, still compared", async () => {
    state.loop = {
      status: "error",
      provider: "google_routes_api",
      distanceKm: null,
      durationMinutes: null,
      minutesBeforePickup: null,
      legs: [],
      error: { code: "request_failed", message: "boom" },
    };
    const check = await runAvailabilityCheck("tenant-1", TR);
    expect(check.candidate).toMatchObject({
      startAt: "2026-10-03T12:30:00.000Z",
      endAt: "2026-10-03T17:30:00.000Z",
      durationToVerify: true,
    });
  });

  it("unreadable date or time: NOT verified, nothing compared", async () => {
    const check = await runAvailabilityCheck("tenant-1", { ...TR, requestedTime: "domani" } as TransferRequest);
    expect(check.candidate).toBeNull();
    expect(check.notVerifiedReasons).toEqual(["data o ora della richiesta non leggibili"]);
    expect(state.bookingQueries).toHaveLength(0);
  });
});
