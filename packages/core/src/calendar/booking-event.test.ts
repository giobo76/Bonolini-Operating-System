import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Every dependency is mocked at its own module boundary (ADR 0002): this
// file tests booking-event.ts's decisions — when an event is created or
// marked cancelled, with which id, times and text — not Google or the DB.

const state = vi.hoisted(() => ({
  bookings: new Map<string, Record<string, unknown>>(),
  connection: { googleCalendarId: "cal@group.calendar.google.com" } as Record<string, unknown> | null,
  insertCalls: [] as Array<Record<string, unknown>>,
  getCalls: [] as Array<Record<string, unknown>>,
  patchCalls: [] as Array<Record<string, unknown>>,
  insertError: null as unknown,
  getResult: { summary: "TRANSFER | Mario Rossi | Malpensa → Sondrio | €390", status: "confirmed", colorId: null } as
    | Record<string, unknown>
    | { throw: unknown },
  rule: null as unknown,
  attachCalls: [] as Array<[string, string, string]>,
  onInsert: null as null | (() => void),
}));

vi.mock("./service", () => ({ getCalendarConnectionRow: async () => state.connection }));

vi.mock("../marketing", () => ({
  getCalendarClient: async () => ({
    events: {
      insert: async (params: Record<string, unknown>) => {
        state.insertCalls.push(params);
        if (state.insertError) throw state.insertError;
        state.onInsert?.();
        return { data: {} };
      },
      get: async (params: Record<string, unknown>) => {
        state.getCalls.push(params);
        if ("throw" in state.getResult) throw state.getResult.throw;
        return { data: state.getResult };
      },
      patch: async (params: Record<string, unknown>) => {
        state.patchCalls.push(params);
        return { data: {} };
      },
    },
  }),
}));

vi.mock("../bookings", () => ({
  getBooking: async (_tenantId: string, id: string) => state.bookings.get(id) ?? null,
  attachCalendarEventToBooking: async (tenantId: string, bookingId: string, eventId: string) => {
    state.attachCalls.push([tenantId, bookingId, eventId]);
    const booking = state.bookings.get(bookingId);
    if (booking && !booking.calendarEventId) booking.calendarEventId = eventId;
    return true;
  },
}));

vi.mock("../clients", () => ({
  getClient: async () => ({ id: "client-1", fullName: "Mario Rossi", phone: "393331234567" }),
}));

vi.mock("../transfer-requests", () => ({
  getTransferRequest: async () => ({
    id: "a1b2c3d4-0000-0000-0000-000000000000",
    pickup: "Malpensa",
    destination: "Sondrio",
    requestedDate: "2026-10-03",
    requestedTime: "14:30",
    passengers: 4,
    children: 0,
    childrenAges: null,
    luggage: "4 valigie",
    flightNumber: "AZ123",
    trainNumber: null,
    hotel: null,
  }),
}));

const mapsMock = vi.hoisted(() => ({ calculateBusyLoopFromBase: vi.fn() }));
vi.mock("../maps-distance", () => mapsMock);

vi.mock("../business-rules", () => ({
  getBusinessRuleByKey: async () => state.rule,
}));

const { createCalendarEventForBooking, markCalendarEventCancelledForBooking } = await import("./booking-event");
const { minimumEventDurationRuleContentSchema } = await import("./schema");

const BOOKING_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const EVENT_ID = "bos0f8fad5bd9cb469fa16570867728950e";

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    tenantId: "tenant-1",
    clientId: "client-1",
    transferRequestId: "a1b2c3d4-0000-0000-0000-000000000000",
    status: "confirmed",
    calendarEventId: null,
    pickup: "Malpensa",
    destination: "Sondrio",
    scheduledAt: new Date("2026-10-03T12:30:00.000Z"),
    finalAmountCents: 39000,
    depositAmountCents: 20000,
    currency: "EUR",
    ...overrides,
  };
}

function ruleWith(content: unknown, extraVersions: unknown[] = []) {
  return { id: "rule-1", versions: [{ id: "v1", status: "effective", content }, ...extraVersions] };
}

const MALPENSA_CONTENT = { minimums: [{ label: "Malpensa", placeKeywords: ["malpensa", "mxp"], minimumMinutes: 300 }] };

function mapsOk(durationMinutes: number, minutesBeforePickup: number) {
  return {
    status: "ok",
    provider: "google_routes_api",
    distanceKm: 300,
    durationMinutes,
    minutesBeforePickup,
    legs: [
      { origin: "Sondrio", destination: "Malpensa", distanceKm: 150, durationMinutes: minutesBeforePickup },
      { origin: "Malpensa", destination: "Sondrio", distanceKm: 150, durationMinutes: durationMinutes - minutesBeforePickup },
    ],
    error: null,
  };
}

beforeEach(() => {
  state.bookings = new Map([[BOOKING_ID, booking()]]);
  state.connection = { googleCalendarId: "cal@group.calendar.google.com" };
  state.insertCalls = [];
  state.getCalls = [];
  state.patchCalls = [];
  state.insertError = null;
  state.getResult = { summary: "TRANSFER | Mario Rossi | Malpensa → Sondrio | €390", status: "confirmed", colorId: null };
  state.rule = ruleWith(MALPENSA_CONTENT);
  state.attachCalls = [];
  state.onInsert = null;
  mapsMock.calculateBusyLoopFromBase.mockReset().mockResolvedValue(mapsOk(330, 130));
});

function inserted() {
  return state.insertCalls[0] as {
    calendarId: string;
    requestBody: {
      id: string;
      summary: string;
      description: string;
      start: { dateTime: string; timeZone: string };
      end: { dateTime: string; timeZone: string };
      extendedProperties: unknown;
    };
  };
}

describe("createCalendarEventForBooking", () => {
  it("creates the event on the selected calendar, with the booking-derived id, and links it to the booking", async () => {
    const outcome = await createCalendarEventForBooking("tenant-1", BOOKING_ID);

    expect(outcome).toBe("created");
    expect(inserted().calendarId).toBe("cal@group.calendar.google.com");
    expect(inserted().requestBody.id).toBe(EVENT_ID);
    expect(inserted().requestBody.summary).toBe("TRANSFER | Mario Rossi | Malpensa → Sondrio | €390");
    expect(inserted().requestBody.extendedProperties).toEqual({ private: { bosBookingId: BOOKING_ID } });
    expect(state.attachCalls).toEqual([["tenant-1", BOOKING_ID, EVENT_ID]]);
  });

  it("italian customer confirmed without deposit (\"Confermato dal cliente\"): the event is created too", async () => {
    state.bookings.set(BOOKING_ID, booking({ depositAmountCents: null }));

    expect(await createCalendarEventForBooking("tenant-1", BOOKING_ID)).toBe("created");
    const description = inserted().requestBody.description;
    expect(description).toContain("Acconto: nessuno (cliente italiano)");
    expect(description).toContain("Da incassare: 390,00 €");
  });

  it("lasts the whole busy loop from Sondrio (Google Maps), starting when the founder leaves", async () => {
    await createCalendarEventForBooking("tenant-1", BOOKING_ID);

    expect(mapsMock.calculateBusyLoopFromBase).toHaveBeenCalledWith("Malpensa", "Sondrio");
    // 14:30 pickup - 130 min to reach Malpensa = 12:20 local; 330 min loop.
    expect(inserted().requestBody.start).toEqual({ dateTime: "2026-10-03T10:20:00.000Z", timeZone: "Europe/Rome" });
    expect(inserted().requestBody.end).toEqual({ dateTime: "2026-10-03T15:50:00.000Z", timeZone: "Europe/Rome" });
    const description = inserted().requestBody.description as string;
    expect(description).toContain("Tempo occupato: Sondrio → Malpensa → Sondrio, circa 5 h 30 min (Google Maps)");
    expect(description).toContain("Acconto ricevuto: 200,00 €");
    expect(description).toContain("Saldo da incassare: 190,00 €");
    expect(description).toContain("Volo: AZ123");
  });

  it("Malpensa: the Business Rule minimum of 5 hours applies to a shorter loop", async () => {
    mapsMock.calculateBusyLoopFromBase.mockResolvedValue(mapsOk(260, 130));

    await createCalendarEventForBooking("tenant-1", BOOKING_ID);

    expect(inserted().requestBody.start.dateTime).toBe("2026-10-03T10:20:00.000Z");
    expect(inserted().requestBody.end.dateTime).toBe("2026-10-03T15:20:00.000Z");
    expect(inserted().requestBody.description).toContain("Durata minima applicata: 5 h (Malpensa)");
  });

  it("the minimum comes from the rule, not from code: without the rule no minimum", async () => {
    mapsMock.calculateBusyLoopFromBase.mockResolvedValue(mapsOk(260, 130));
    state.rule = null;

    await createCalendarEventForBooking("tenant-1", BOOKING_ID);

    expect(inserted().requestBody.end.dateTime).toBe("2026-10-03T14:40:00.000Z");
    expect(inserted().requestBody.description).not.toContain("Durata minima");
    expect(inserted().requestBody.description).not.toContain("Durata da verificare");
  });

  it("Google Maps gives no duration: 2 hours from pickup (5 on Malpensa routes) and 'Durata da verificare'", async () => {
    mapsMock.calculateBusyLoopFromBase.mockResolvedValue({
      status: "error",
      provider: "google_routes_api",
      distanceKm: null,
      durationMinutes: null,
      minutesBeforePickup: null,
      legs: [],
      error: { code: "request_failed", message: "boom" },
    });
    state.rule = null;

    await createCalendarEventForBooking("tenant-1", BOOKING_ID);
    expect(inserted().requestBody.start.dateTime).toBe("2026-10-03T12:30:00.000Z");
    expect(inserted().requestBody.end.dateTime).toBe("2026-10-03T14:30:00.000Z");
    expect(inserted().requestBody.description).toContain("Durata da verificare");

    state.insertCalls = [];
    state.bookings.set(BOOKING_ID, booking());
    state.rule = ruleWith(MALPENSA_CONTENT);
    await createCalendarEventForBooking("tenant-1", BOOKING_ID);
    expect(inserted().requestBody.end.dateTime).toBe("2026-10-03T17:30:00.000Z");
    expect(inserted().requestBody.description).toContain("Durata da verificare");
  });

  it("an unreadable minimum rule: event still created, duration to be checked", async () => {
    state.rule = ruleWith({ minimums: "five hours" });

    await createCalendarEventForBooking("tenant-1", BOOKING_ID);

    expect(inserted().requestBody.description).toContain("Durata da verificare: la regola delle durate minime non è leggibile.");
  });

  it("a booking that came from Google Calendar already has its event: nothing is created", async () => {
    state.bookings.set(BOOKING_ID, booking({ calendarEventId: "founder-evt-1" }));

    expect(await createCalendarEventForBooking("tenant-1", BOOKING_ID)).toBe("skipped_has_event");
    expect(state.insertCalls).toHaveLength(0);
  });

  it.each([
    ["pending_deposit", "skipped_not_confirmed"],
    ["cancelled", "skipped_not_confirmed"],
  ])("a %s booking gets no event", async (status, outcome) => {
    state.bookings.set(BOOKING_ID, booking({ status }));

    expect(await createCalendarEventForBooking("tenant-1", BOOKING_ID)).toBe(outcome);
    expect(state.insertCalls).toHaveLength(0);
  });

  it("no calendar selected: nothing created, no error", async () => {
    state.connection = null;

    expect(await createCalendarEventForBooking("tenant-1", BOOKING_ID)).toBe("skipped_no_calendar");
    expect(state.insertCalls).toHaveLength(0);
  });

  it("a retry after the event was already inserted (409): no second event, the booking is linked", async () => {
    state.insertError = Object.assign(new Error("duplicate"), { code: 409 });

    expect(await createCalendarEventForBooking("tenant-1", BOOKING_ID)).toBe("already_exists");
    expect(state.attachCalls).toEqual([["tenant-1", BOOKING_ID, EVENT_ID]]);
  });

  it("any other Google error (e.g. permission not granted yet) is thrown for Inngest to retry; nothing linked", async () => {
    state.insertError = Object.assign(new Error("Insufficient Permission"), { code: 403 });

    await expect(createCalendarEventForBooking("tenant-1", BOOKING_ID)).rejects.toThrow("Insufficient Permission");
    expect(state.attachCalls).toHaveLength(0);
  });

  it("cancelled while the event was being created: the new event is marked ANNULLATO straight away", async () => {
    state.onInsert = () => {
      state.bookings.set(BOOKING_ID, { ...state.bookings.get(BOOKING_ID)!, status: "cancelled" });
    };

    await createCalendarEventForBooking("tenant-1", BOOKING_ID);

    expect(state.patchCalls).toHaveLength(1);
  });
});

describe("markCalendarEventCancelledForBooking", () => {
  beforeEach(() => {
    state.bookings.set(BOOKING_ID, booking({ status: "cancelled", calendarEventId: EVENT_ID }));
  });

  it("keeps the event: 'ANNULLATO – ' title and grey colour", async () => {
    expect(await markCalendarEventCancelledForBooking("tenant-1", BOOKING_ID)).toBe("marked_cancelled");
    expect(state.patchCalls).toEqual([
      {
        calendarId: "cal@group.calendar.google.com",
        eventId: EVENT_ID,
        requestBody: { summary: "ANNULLATO – TRANSFER | Mario Rossi | Malpensa → Sondrio | €390", colorId: "8" },
      },
    ]);
  });

  it("already marked: no second patch", async () => {
    state.getResult = { summary: "ANNULLATO – TRANSFER | Mario Rossi", status: "confirmed", colorId: "8" };

    expect(await markCalendarEventCancelledForBooking("tenant-1", BOOKING_ID)).toBe("already_marked");
    expect(state.patchCalls).toHaveLength(0);
  });

  it("never touches an event the founder created himself", async () => {
    state.bookings.set(BOOKING_ID, booking({ status: "cancelled", calendarEventId: "founder-evt-1" }));

    expect(await markCalendarEventCancelledForBooking("tenant-1", BOOKING_ID)).toBe("skipped_not_bos_event");
    expect(state.getCalls).toHaveLength(0);
    expect(state.patchCalls).toHaveLength(0);
  });

  it("event not there (never created, or deleted by hand): nothing to do", async () => {
    state.getResult = { throw: Object.assign(new Error("Not Found"), { code: 404 }) };
    expect(await markCalendarEventCancelledForBooking("tenant-1", BOOKING_ID)).toBe("skipped_no_event");

    state.getResult = { summary: "TRANSFER | Mario Rossi", status: "cancelled" };
    expect(await markCalendarEventCancelledForBooking("tenant-1", BOOKING_ID)).toBe("skipped_no_event");
    expect(state.patchCalls).toHaveLength(0);
  });

  it("a booking that is not cancelled is never marked", async () => {
    state.bookings.set(BOOKING_ID, booking({ calendarEventId: EVENT_ID }));

    expect(await markCalendarEventCancelledForBooking("tenant-1", BOOKING_ID)).toBe("skipped_not_cancelled");
    expect(state.patchCalls).toHaveLength(0);
  });
});

describe("migration 0031 seed", () => {
  it("is valid content for the minimum-duration rule: Malpensa, 5 hours", () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, "../../../db/migrations/0031_calendar_minimum_event_duration.sql"),
      "utf8",
    );
    const json = /'(\{"minimums".*?\})'::jsonb/.exec(sql)?.[1];
    const content = minimumEventDurationRuleContentSchema.parse(JSON.parse(json!));
    expect(content.minimums).toEqual([{ label: "Malpensa", placeKeywords: ["malpensa", "mxp"], minimumMinutes: 300 }]);
    expect(sql).toContain("'decisione del titolare 2026-09-25'");
  });
});
