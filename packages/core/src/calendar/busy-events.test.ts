import { describe, expect, it, vi, beforeEach } from "vitest";

// Read-only listing of the founder's calendar for the overlap check
// (founder decisions 2026-09-26).

const state = vi.hoisted(() => ({
  connection: { googleCalendarId: "cal@group.calendar.google.com" } as Record<string, unknown> | null,
  pages: [] as Array<{ items: Array<Record<string, unknown>>; nextPageToken?: string }>,
  listCalls: [] as Array<Record<string, unknown>>,
  fail: null as unknown,
}));

vi.mock("./service", () => ({ getCalendarConnectionRow: async () => state.connection }));
vi.mock("../marketing", () => ({
  getCalendarClient: async () => ({
    events: {
      list: async (params: Record<string, unknown>) => {
        state.listCalls.push(params);
        if (state.fail) throw state.fail;
        return { data: state.pages.shift() ?? { items: [] } };
      },
    },
  }),
}));

const { listCalendarBusyEvents, toCalendarBusyEvent } = await import("./busy-events");

const FROM = new Date("2026-10-03T10:00:00.000Z");
const TO = new Date("2026-10-03T15:00:00.000Z");

beforeEach(() => {
  state.connection = { googleCalendarId: "cal@group.calendar.google.com" };
  state.pages = [];
  state.listCalls = [];
  state.fail = null;
});

describe("toCalendarBusyEvent", () => {
  it("a timed event", () => {
    expect(
      toCalendarBusyEvent({
        id: "e1",
        summary: "Dentista",
        start: { dateTime: "2026-10-03T15:00:00+02:00" },
        end: { dateTime: "2026-10-03T16:00:00+02:00" },
      }),
    ).toEqual({
      id: "e1",
      summary: "Dentista",
      startAt: new Date("2026-10-03T13:00:00.000Z"),
      endAt: new Date("2026-10-03T14:00:00.000Z"),
      allDay: false,
    });
  });

  it("an all-day event covers the whole day in Europe/Rome", () => {
    expect(
      toCalendarBusyEvent({ id: "e2", summary: "Ferie", start: { date: "2026-10-03" }, end: { date: "2026-10-04" } }),
    ).toMatchObject({ startAt: new Date("2026-10-02T22:00:00.000Z"), endAt: new Date("2026-10-03T22:00:00.000Z"), allDay: true });
  });

  it("skips 'Libero', cancelled and BOS-created events", () => {
    const times = { start: { dateTime: "2026-10-03T15:00:00+02:00" }, end: { dateTime: "2026-10-03T16:00:00+02:00" } };
    expect(toCalendarBusyEvent({ id: "free", transparency: "transparent", ...times })).toBeNull();
    expect(toCalendarBusyEvent({ id: "gone", status: "cancelled", ...times })).toBeNull();
    expect(toCalendarBusyEvent({ id: "bos0123456789abcdef0123456789abcdef", ...times })).toBeNull();
    expect(toCalendarBusyEvent({ id: "marked", extendedProperties: { private: { bosBookingId: "b-1" } }, ...times })).toBeNull();
  });
});

describe("listCalendarBusyEvents", () => {
  it("reads the selected calendar in the time range, every page, read-only", async () => {
    state.pages = [
      {
        items: [{ id: "a", summary: "A", start: { dateTime: "2026-10-03T12:00:00Z" }, end: { dateTime: "2026-10-03T13:00:00Z" } }],
        nextPageToken: "p2",
      },
      { items: [{ id: "b", summary: "B", start: { dateTime: "2026-10-03T14:00:00Z" }, end: { dateTime: "2026-10-03T15:00:00Z" } }] },
    ];

    const result = await listCalendarBusyEvents("tenant-1", FROM, TO);

    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(state.listCalls[0]).toMatchObject({
      calendarId: "cal@group.calendar.google.com",
      timeMin: FROM.toISOString(),
      timeMax: TO.toISOString(),
      singleEvents: true,
    });
    expect(state.listCalls[1]?.pageToken).toBe("p2");
  });

  it("no calendar selected: said so, never 'no events'", async () => {
    state.connection = null;
    expect(await listCalendarBusyEvents("tenant-1", FROM, TO)).toEqual({ status: "not_connected" });
  });

  it("Google error: said so, never 'no events'", async () => {
    state.fail = new Error("invalid_grant");
    expect(await listCalendarBusyEvents("tenant-1", FROM, TO)).toEqual({ status: "error", message: "invalid_grant" });
  });
});
