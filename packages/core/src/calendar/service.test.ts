import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Client } from "@bos/db";

// Three independent mock surfaces:
// 1. @bos/db — only calendar_connections (this module's own table).
// 2. ../marketing — getCalendarClient, swapped for a fully scriptable fake
//    Calendar v3 API (calendarList.list / events.list) so tests never touch
//    real OAuth or network.
// 3. ../clients and ../bookings — this module's only two cross-module
//    dependencies, per ADR 0002. Mocked at their own public boundary
//    (not @bos/db) so this file tests calendar/service.ts's orchestration
//    logic specifically, not clients'/bookings' own upsert correctness —
//    that's already covered by clients/service.test.ts and
//    bookings/service.test.ts.
const { fakeState, calendarConnectionsTable } = vi.hoisted(() => {
  return {
    fakeState: {
      connections: [] as Array<Record<string, unknown>>,
      calendarListResponse: { items: [] as Array<Record<string, unknown>> },
      // Queue of events.list() responses, consumed in call order — lets a
      // test script a 410 on the first call and a real page on the second.
      eventsListQueue: [] as Array<
        | { items: Array<Record<string, unknown>>; nextPageToken?: string; nextSyncToken?: string }
        | { throw: unknown }
      >,
      eventsListCalls: [] as Array<Record<string, unknown>>,
    },
    calendarConnectionsTable: { __name: "calendarConnections" },
  };
});

vi.mock("@bos/db", () => ({
  calendarConnections: calendarConnectionsTable,
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(fakeState.connections),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        fakeState.connections.push({ id: "conn-1", createdAt: new Date(), updatedAt: new Date(), ...values });
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          Object.assign(fakeState.connections[0] ?? {}, values);
          return Promise.resolve();
        },
      }),
    }),
  }),
}));

vi.mock("../marketing", () => ({
  getCalendarClient: async () => {
    if (getCalendarClientFailure.shouldThrow) {
      throw new Error("invalid_grant");
    }
    return {
      calendarList: {
        list: async () => ({ data: fakeState.calendarListResponse }),
      },
      events: {
        list: async (params: Record<string, unknown>) => {
          fakeState.eventsListCalls.push(params);
          const next = fakeState.eventsListQueue.shift();
          if (!next) return { data: { items: [] } };
          if ("throw" in next) throw next.throw;
          return { data: next };
        },
      },
    };
  },
}));

const clientsMock = vi.hoisted(() => ({
  findClientByPhone: vi.fn(),
  findOrCreateClientByPhone: vi.fn(),
}));
vi.mock("../clients", () => clientsMock);

const bookingsMock = vi.hoisted(() => ({
  ensureBookingFromCalendarEvent: vi.fn(),
  getBookingByCalendarEventId: vi.fn(),
  cancelBookingByCalendarEventId: vi.fn(),
}));
vi.mock("../bookings", () => bookingsMock);

// getCalendarClient itself is mocked above (via ../marketing) as an async
// factory that always succeeds — this hoisted flag lets one specific
// regression test make it throw instead, to reproduce the exact 2026-09-04
// bug (getCalendarClient failing OUTSIDE syncCalendarEvents' try block,
// so calendar_connections' error status was never recorded).
const getCalendarClientFailure = vi.hoisted(() => ({ shouldThrow: false }));

const { listAvailableCalendars, getCalendarConfig, selectCalendar, syncCalendarEvents } = await import("./service");

function fakeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: "client-1",
    tenantId: "tenant-1",
    profileId: null,
    customerType: "private",
    fullName: "Mario Rossi",
    companyName: null,
    email: null,
    phone: "393331234567",
    country: null,
    preferredLanguage: null,
    notes: null,
    marketingConsent: false,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    gclid: null,
    landingPage: null,
    referrer: null,
    firstTouchAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Client;
}

function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    tenantId: "tenant-1",
    clientId: "client-1",
    calendarEventId: "evt-1",
    status: "confirmed",
    ...overrides,
  };
}

beforeEach(() => {
  fakeState.connections = [];
  fakeState.calendarListResponse = { items: [] };
  fakeState.eventsListQueue = [];
  fakeState.eventsListCalls = [];
  getCalendarClientFailure.shouldThrow = false;
  clientsMock.findClientByPhone.mockReset();
  clientsMock.findOrCreateClientByPhone.mockReset();
  bookingsMock.ensureBookingFromCalendarEvent.mockReset().mockResolvedValue(fakeBooking());
  bookingsMock.getBookingByCalendarEventId.mockReset().mockResolvedValue(null);
  bookingsMock.cancelBookingByCalendarEventId.mockReset().mockResolvedValue(fakeBooking({ status: "cancelled" }));
});

describe("listAvailableCalendars", () => {
  it("maps Google's real calendarList response, never inventing a calendar id", async () => {
    fakeState.calendarListResponse = {
      items: [
        { id: "primary", summary: "Mario Rossi", timeZone: "Europe/Rome", accessRole: "owner" },
        { id: "abc@group.calendar.google.com", summary: "Bonolini Transfer", timeZone: "Europe/Rome", accessRole: "owner" },
      ],
    };

    const calendars = await listAvailableCalendars("tenant-1");

    expect(calendars).toEqual([
      { id: "primary", name: "Mario Rossi", timezone: "Europe/Rome", accessRole: "owner" },
      { id: "abc@group.calendar.google.com", name: "Bonolini Transfer", timezone: "Europe/Rome", accessRole: "owner" },
    ]);
  });
});

describe("getCalendarConfig / selectCalendar", () => {
  it("reports not configured when no calendar has been selected yet", async () => {
    const config = await getCalendarConfig("tenant-1");
    expect(config.configured).toBe(false);
  });

  // TEST 2 — selezione calendario.
  it("persists the exact selected calendar — never invents an id", async () => {
    await selectCalendar("tenant-1", {
      googleCalendarId: "abc@group.calendar.google.com",
      googleCalendarName: "Bonolini Transfer",
      timezone: "Europe/Rome",
    });

    const config = await getCalendarConfig("tenant-1");
    expect(config.configured).toBe(true);
    expect(config.googleCalendarId).toBe("abc@group.calendar.google.com");
    expect(config.googleCalendarName).toBe("Bonolini Transfer");
  });
});

describe("syncCalendarEvents — not configured", () => {
  it("is a safe no-op when no calendar has been selected — Calendar is never required", async () => {
    const result = await syncCalendarEvents("tenant-1");

    expect(result).toEqual({
      eventsSeen: 0,
      bookingsCreated: 0,
      bookingsUpdated: 0,
      bookingsCancelled: 0,
      eventsSkippedNoClientData: 0,
      eventsIgnoredNotAService: 0,
      fullResync: false,
    });
    expect(fakeState.eventsListCalls).toHaveLength(0);
  });
});

describe("syncCalendarEvents — configured", () => {
  beforeEach(async () => {
    await selectCalendar("tenant-1", {
      googleCalendarId: "abc@group.calendar.google.com",
      googleCalendarName: "Bonolini Transfer",
      timezone: "Europe/Rome",
    });
  });

  // TEST 13 — evento fuori dal calendario Bonolini -> ignorato (the primary
  // filter: only the configured calendarId is ever queried).
  it("only ever queries the explicitly selected calendar", async () => {
    fakeState.eventsListQueue = [{ items: [] }];

    await syncCalendarEvents("tenant-1");

    expect(fakeState.eventsListCalls[0]?.calendarId).toBe("abc@group.calendar.google.com");
  });

  it("a first sync (no syncToken yet) is a bounded full sync with timeMin, never combined with a syncToken", async () => {
    fakeState.eventsListQueue = [{ items: [] }];

    const result = await syncCalendarEvents("tenant-1");

    expect(result.fullResync).toBe(true);
    expect(fakeState.eventsListCalls[0]?.syncToken).toBeUndefined();
    expect(fakeState.eventsListCalls[0]?.timeMin).toBeTruthy();
  });

  // TEST 3/4 — nuovo evento -> crea booking (-> real conversion, via
  // bookings.status, unchanged by this module).
  it("creates a booking for a new recognizable event, resolving the client by phone", async () => {
    clientsMock.findClientByPhone.mockResolvedValue(fakeClient());
    fakeState.eventsListQueue = [
      {
        items: [
          {
            id: "evt-1",
            summary: "TRANSFER | Mario Rossi | Milano → Tirano | €390",
            description: "Phone: +39 333 1234567",
            start: { dateTime: "2026-09-20T09:00:00+02:00" },
          },
        ],
        nextSyncToken: "sync-token-1",
      },
    ];

    const result = await syncCalendarEvents("tenant-1");

    expect(result.eventsSeen).toBe(1);
    expect(result.bookingsCreated).toBe(1);
    expect(bookingsMock.ensureBookingFromCalendarEvent).toHaveBeenCalledWith(
      "tenant-1",
      expect.objectContaining({
        calendarEventId: "evt-1",
        clientId: "client-1",
        pickup: "Milano",
        destination: "Tirano",
        finalAmountCents: 39000,
      }),
    );
  });

  // TEST 10 — GCLID -> attribuzione passata al nuovo cliente.
  it("passes gclid/utm attribution only when creating a brand-new client", async () => {
    clientsMock.findClientByPhone.mockResolvedValue(null);
    clientsMock.findOrCreateClientByPhone.mockResolvedValue(fakeClient({ id: "client-new" }));
    fakeState.eventsListQueue = [
      {
        items: [
          {
            id: "evt-1",
            summary: "TRANSFER | Anna Bianchi | Milano → Tirano | €390",
            description: "Phone: +39 333 9999999\nGCLID: Cj0KEQjw_test\nUTM Source: google",
            start: { dateTime: "2026-09-20T09:00:00+02:00" },
          },
        ],
      },
    ];

    await syncCalendarEvents("tenant-1");

    expect(clientsMock.findOrCreateClientByPhone).toHaveBeenCalledWith(
      "tenant-1",
      "+39 333 9999999",
      "Anna Bianchi",
      expect.any(Date),
      { gclid: "Cj0KEQjw_test", utmSource: "google", utmCampaign: null },
    );
  });

  // TEST 18 — booking già esistente -> nessun duplicato, e la seconda volta
  // il cliente non viene nemmeno ricercato per telefono di nuovo.
  it("reuses the existing booking's clientId on a re-sync, without a new phone lookup", async () => {
    bookingsMock.getBookingByCalendarEventId.mockResolvedValue(fakeBooking({ clientId: "client-existing" }));
    fakeState.eventsListQueue = [
      {
        items: [
          {
            id: "evt-1",
            summary: "Milano → Tirano",
            description: "Phone: +39 333 1234567",
            start: { dateTime: "2026-09-20T09:00:00+02:00" },
          },
        ],
      },
    ];

    const result = await syncCalendarEvents("tenant-1");

    expect(result.bookingsUpdated).toBe(1);
    expect(clientsMock.findClientByPhone).not.toHaveBeenCalled();
    expect(bookingsMock.ensureBookingFromCalendarEvent).toHaveBeenCalledWith(
      "tenant-1",
      expect.objectContaining({ clientId: "client-existing" }),
    );
  });

  // TEST 13 (structural) — an event with no recognizable route is ignored,
  // never becomes a booking.
  it("ignores an event with no recognizable pickup -> destination route", async () => {
    fakeState.eventsListQueue = [{ items: [{ id: "evt-1", summary: "Dentist appointment", start: {} }] }];

    const result = await syncCalendarEvents("tenant-1");

    expect(result.eventsIgnoredNotAService).toBe(1);
    expect(bookingsMock.ensureBookingFromCalendarEvent).not.toHaveBeenCalled();
  });

  // TEST 9 (orchestration side) / real-world gap documented in README —
  // recognizable route but no phone at all -> skipped, never invented.
  it("skips (never invents) client data when the event has no phone", async () => {
    fakeState.eventsListQueue = [{ items: [{ id: "evt-1", summary: "Milano → Tirano", start: {} }] }];

    const result = await syncCalendarEvents("tenant-1");

    expect(result.eventsSkippedNoClientData).toBe(1);
    expect(bookingsMock.ensureBookingFromCalendarEvent).not.toHaveBeenCalled();
  });

  it("skips when a phone is present but matches no existing client and no name is extractable", async () => {
    clientsMock.findClientByPhone.mockResolvedValue(null);
    fakeState.eventsListQueue = [
      { items: [{ id: "evt-1", summary: "Milano → Tirano", description: "Phone: +39 333 1234567", start: {} }] },
    ];

    const result = await syncCalendarEvents("tenant-1");

    expect(result.eventsSkippedNoClientData).toBe(1);
    expect(clientsMock.findOrCreateClientByPhone).not.toHaveBeenCalled();
  });

  // TEST 7 — cancellazione evento -> booking cancelled.
  it("cancels the matching booking when Google reports the event as cancelled", async () => {
    fakeState.eventsListQueue = [{ items: [{ id: "evt-1", status: "cancelled" }] }];

    const result = await syncCalendarEvents("tenant-1");

    expect(result.bookingsCancelled).toBe(1);
    expect(bookingsMock.cancelBookingByCalendarEventId).toHaveBeenCalledWith("tenant-1", "evt-1");
    expect(bookingsMock.ensureBookingFromCalendarEvent).not.toHaveBeenCalled();
  });

  it("paginates through every page before persisting the final nextSyncToken", async () => {
    fakeState.eventsListQueue = [
      { items: [{ id: "evt-1", status: "cancelled" }], nextPageToken: "page-2" },
      { items: [{ id: "evt-2", status: "cancelled" }], nextSyncToken: "final-token" },
    ];

    const result = await syncCalendarEvents("tenant-1");

    expect(result.eventsSeen).toBe(2);
    expect(fakeState.eventsListCalls).toHaveLength(2);
    expect(fakeState.connections[0]?.syncToken).toBe("final-token");
  });

  // TEST 16 — expired sync token -> full resync, bounded (one retry only).
  it("clears the sync token and performs one bounded full resync on a 410 error", async () => {
    fakeState.connections[0]!.syncToken = "stale-token";
    fakeState.eventsListQueue = [
      { throw: Object.assign(new Error("Sync token is no longer valid"), { code: 410 }) },
      { items: [{ id: "evt-1", status: "cancelled" }], nextSyncToken: "fresh-token" },
    ];

    const result = await syncCalendarEvents("tenant-1");

    expect(result.fullResync).toBe(true);
    expect(fakeState.eventsListCalls).toHaveLength(2);
    expect(fakeState.eventsListCalls[0]?.syncToken).toBe("stale-token");
    expect(fakeState.eventsListCalls[1]?.syncToken).toBeUndefined();
    expect(fakeState.eventsListCalls[1]?.timeMin).toBeTruthy();
    expect(fakeState.connections[0]?.syncToken).toBe("fresh-token");
    expect(fakeState.connections[0]?.lastSyncStatus).toBe("ok");
  });

  // TEST 15 — errore OAuth/API non recuperabile -> gestito correttamente
  // (stato persistito, errore rilanciato, mai inghiottito silenziosamente).
  it("records the error on calendar_connections and rethrows for an unrecoverable API error", async () => {
    fakeState.eventsListQueue = [{ throw: new Error("invalid_grant") }];

    await expect(syncCalendarEvents("tenant-1")).rejects.toThrow("invalid_grant");

    expect(fakeState.connections[0]?.lastSyncStatus).toBe("error");
    expect(fakeState.connections[0]?.lastSyncError).toBe("invalid_grant");
  });

  // Regression for the real 2026-09-04 bug: getCalendarClient() used to be
  // called OUTSIDE the try block, so a failure acquiring the client (e.g.
  // an OAuth issue) skipped error handling entirely and left
  // calendar_connections permanently un-updated, with no error ever
  // recorded and the dashboard stuck showing "never synced" forever.
  it("records the error on calendar_connections even when the failure happens acquiring the Calendar client itself, not just during events.list", async () => {
    getCalendarClientFailure.shouldThrow = true;

    await expect(syncCalendarEvents("tenant-1")).rejects.toThrow("invalid_grant");

    expect(fakeState.connections[0]?.lastSyncStatus).toBe("error");
    expect(fakeState.connections[0]?.lastSyncError).toBe("invalid_grant");
    expect(fakeState.eventsListCalls).toHaveLength(0);
  });

  // End-to-end regression for the exact real-world bug report: the event
  // is correctly recognized (route parsed fine — that was never the
  // actual bug) but, having genuinely no description at all, is correctly
  // skipped for missing client data rather than silently dropped or
  // fabricated — this is the true, demonstrated root cause, not a parser
  // failure.
  it("reproduces the real bug report end-to-end: 'Sondrio → Malpensa' with no description is recognized but skipped, never silently dropped", async () => {
    fakeState.eventsListQueue = [
      { items: [{ id: "real-event-id", summary: "Sondrio → Malpensa", description: null, start: { dateTime: "2026-09-23T10:00:00+02:00" } }] },
    ];

    const result = await syncCalendarEvents("tenant-1");

    expect(result.eventsSeen).toBe(1);
    expect(result.eventsIgnoredNotAService).toBe(0); // the route WAS recognized
    expect(result.eventsSkippedNoClientData).toBe(1); // skipped for the real reason: no phone
    expect(result.bookingsCreated).toBe(0);
    expect(clientsMock.findClientByPhone).not.toHaveBeenCalled(); // no phone to even look up
  });
});
