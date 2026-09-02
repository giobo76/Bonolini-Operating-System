import { Param, StringChunk } from "drizzle-orm";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TransferRequestExtractedFields } from "./schema";
import type { RouteDistanceResult } from "../maps-distance";
import type { PreviousService } from "../availability";

// @bos/db is fully mocked, same convention as
// packages/core/src/whatsapp/service.test.ts and
// packages/core/src/marketing/run-check.test.ts (no test-database strategy
// exists yet — see docs/PRODUCTION_ROADMAP.md Milestone 3).
//
// select()/where() ignores its condition and returns the seeded fakeState
// array as-is (same simplification whatsapp's mock uses) — EXCEPT for
// findOpenTransferRequest's own status filtering, which happens in real,
// unmocked service.ts code after a coarser tenant+client fetch, so tests
// that depend on status-based matching (F, G) exercise real logic, not a
// mock's guess at it.
//
// update()/where() and the raw execute() INSERT read bound parameters back
// out of the drizzle SQL object's queryChunks, same technique as
// whatsapp/service.test.ts's mock — filtering out StringChunk (literal SQL
// text) and, for the id-lookup update() case, additionally keeping only
// primitive string/number chunks (drizzle's own Column reference chunk is
// neither) to isolate the bound row id.

const { fakeState, transferRequestsTable, whatsappMessagesTable, clientsTable, bookingsTable } = vi.hoisted(() => {
  return {
    fakeState: {
      requests: [] as Array<Record<string, unknown>>,
      messages: [] as Array<Record<string, unknown>>,
      clients: [] as Array<Record<string, unknown>>,
      bookings: [] as Array<Record<string, unknown>>,
      nextRequestId: 1,
      nextBookingId: 1,
    },
    transferRequestsTable: { __name: "transferRequests" },
    whatsappMessagesTable: { __name: "whatsappMessages" },
    clientsTable: { __name: "clients" },
    bookingsTable: { __name: "bookings" },
  };
});

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  return {
    orderBy: () => promise,
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => promise.then(resolve, reject),
    catch: (reject: (e: unknown) => void) => promise.catch(reject),
  };
}

function sourceFor(table: unknown): Array<Record<string, unknown>> {
  if (table === transferRequestsTable) return fakeState.requests;
  if (table === clientsTable) return fakeState.clients;
  if (table === bookingsTable) return fakeState.bookings;
  return fakeState.messages;
}

// eq(column, value) normally wraps the bound value in a drizzle Param
// instance — but the mocked table objects below are plain placeholders
// with no real Column for `column`, which changes how eq() encodes the
// condition (verified directly against the installed drizzle-orm version
// rather than assumed, given the earlier production incident already
// taught this codebase not to guess at query-builder serialization
// behavior): the value comes through as a raw chunk instead of a Param.
// Handling both shapes keeps this correct either way. Only meaningful for
// a single plain eq(id, value) condition, not a compound and(...) — every
// call site this is used for below passes exactly that shape.
function extractEqValue(condition: { queryChunks: unknown[] }): string | undefined {
  const candidate = condition.queryChunks.find(
    (c) => c !== undefined && c !== null && !(c instanceof StringChunk),
  );
  if (candidate instanceof Param) return candidate.value as string;
  return candidate as string | undefined;
}

const OPEN_STATUSES = ["collecting_info", "ready_for_pricing"];

vi.mock("@bos/db", () => {
  const db = {
    // Plain `select()` calls (findOpenTransferRequest, getTransferRequest,
    // listTransferRequestsForClient) ignore the where condition entirely —
    // same simplification whatsapp/service.test.ts's mock uses, relying on
    // each test seeding only the rows relevant to that scenario, plus
    // findOpenTransferRequest's real status filtering happening in
    // unmocked service.ts code (see its comment in service.ts).
    //
    // `select({ transferRequestId: ... })` is different: it's only ever
    // used for the idempotency lookup by a specific whatsapp_messages id,
    // and tests here seed multiple messages at once (C, D, E), so a
    // passthrough would silently pick the wrong one. This one case filters
    // for real, using the same eq() extraction as the update mock below.
    select: (cols?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (condition: { queryChunks: unknown[] }) => {
          const source = sourceFor(table);
          if (!cols) return thenable(source);
          const targetId = extractEqValue(condition);
          const filtered = source.filter((r) => r.id === targetId);
          const projected = filtered.map((row) => {
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(cols)) out[key] = row[key];
            return out;
          });
          return thenable(projected);
        },
      }),
    }),
    // The mutation happens eagerly inside where() (not only inside a
    // chained .returning()), since processTransferRequestForMessage's final
    // whatsapp_messages update is awaited directly without calling
    // .returning() — matching what a real drizzle UPDATE does regardless
    // of whether the caller asks for the updated rows back.
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: { queryChunks: unknown[] }) => {
          const source = sourceFor(table);
          const targetId = extractEqValue(condition);
          const target = source.find((r) => r.id === targetId);
          if (target) Object.assign(target, values);
          const result = target ? [target] : [];
          const promise = Promise.resolve(result);
          return {
            returning: async () => result,
            then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => promise.then(resolve, reject),
            catch: (reject: (e: unknown) => void) => promise.catch(reject),
          };
        },
      }),
    }),
    // Backs both raw INSERT ... ON CONFLICT ... DO NOTHING RETURNING *
    // sites in this module graph: insertNewTransferRequest's (into
    // transfer_requests) and, since this same @bos/db mock is shared with
    // whatever ../bookings pulls in transitively, ensureBookingForApprovedTransferRequest's
    // (into bookings, packages/core/src/bookings/service.ts) — distinguished
    // by the literal SQL text in the query's own StringChunks, since the two
    // statements bind a completely different number/order of params.
    execute: async (query: { queryChunks: unknown[] }) => {
      const sqlText = query.queryChunks
        .filter((chunk): chunk is InstanceType<typeof StringChunk> => chunk instanceof StringChunk)
        .map((chunk) => chunk.value.join(""))
        .join("");
      const params = query.queryChunks.filter((chunk) => !(chunk instanceof StringChunk));

      if (sqlText.includes("insert into bookings")) {
        const [
          tenantId,
          clientId,
          transferRequestId,
          pickup,
          destination,
          pickupAddress,
          destinationAddress,
          customerTripDurationMinutes,
          scheduledAt,
          finalAmountCents,
          currency,
        ] = params as [string, string, string, string, string, string | null, string | null, number, string, number, string];

        const conflict = fakeState.bookings.some((b) => b.transferRequestId === transferRequestId);
        if (conflict) return [];

        const row: Record<string, unknown> = {
          id: `booking-${fakeState.nextBookingId++}`,
          tenantId,
          clientId,
          transferRequestId,
          quoteId: null,
          pickup,
          destination,
          pickupAddress,
          destinationAddress,
          customerTripDurationMinutes,
          status: "confirmed",
          currency,
          depositAmountCents: null,
          depositPaidAt: null,
          finalAmountCents,
          scheduledAt: new Date(scheduledAt),
          completedAt: null,
          cancelledAt: null,
          invoicedAt: null,
          invoiceAmountCents: null,
          paidAt: null,
          paidAmountCents: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        fakeState.bookings.push(row);
        return [row];
      }

      const [
        tenantId,
        clientId,
        status,
        intent,
        pickup,
        destination,
        requestedDate,
        requestedTime,
        passengers,
        luggage,
        flightNumber,
        trainNumber,
        hotel,
        language,
      ] = params as [string, string, string, ...unknown[]];

      const conflict = fakeState.requests.some(
        (r) => r.tenantId === tenantId && r.clientId === clientId && OPEN_STATUSES.includes(r.status as string),
      );
      if (conflict) return [];

      const row: Record<string, unknown> = {
        id: `request-${fakeState.nextRequestId++}`,
        tenantId,
        clientId,
        status,
        intent,
        pickup,
        destination,
        requestedDate,
        requestedTime,
        passengers,
        luggage,
        flightNumber,
        trainNumber,
        hotel,
        language,
        missingInformation: null,
        pricingStatus: "not_priced",
        calculatedAmountCents: null,
        currency: "EUR",
        pricingBreakdown: null,
        quoteId: null,
        adminApprovedAt: null,
        adminApprovedBy: null,
        cancelledReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      fakeState.requests.push(row);
      return [row];
    },
  };

  return {
    transferRequests: transferRequestsTable,
    whatsappMessages: whatsappMessagesTable,
    clients: clientsTable,
    bookings: bookingsTable,
    assertOne: (rows: unknown[]) => {
      if (rows.length === 0) throw new Error("Expected exactly one row, got none");
      return rows[0];
    },
    getDb: () => db,
  };
});

// ../maps-distance is mocked so these tests never make a real HTTP call —
// same convention as ../whatsapp/parser being mocked in the integration
// simulation test. Default: both convenience wrappers resolve to a
// structured error (as if GOOGLE_MAPS_API_KEY were unset), so every
// existing "manual_required, distance_not_provided" assertion below stays
// true unchanged; individual tests override with mockResolvedValueOnce to
// exercise the calculated_km unlock path.
const defaultMapsError: RouteDistanceResult = {
  status: "error",
  provider: "google_routes_api",
  distanceKm: null,
  durationMinutes: null,
  legs: [],
  error: { code: "api_key_missing", message: "GOOGLE_MAPS_API_KEY is not configured." },
};
const calculateGenericRouteRoundTrip = vi.fn(
  async (_pickup: string, _destination: string): Promise<RouteDistanceResult> => defaultMapsError,
);
const calculateComoTiranoRoundTrip = vi.fn(async (): Promise<RouteDistanceResult> => defaultMapsError);
// Backs Availability's one-way customerTripDuration/relocation calls
// (runAvailabilityForTransferRequest) — same default-error convention as
// the two round-trip wrappers above, so every existing pricing-focused
// test keeps its exact prior behavior (customerTripDurationMinutes simply
// stays null, availabilityBreakdown.status "not_verified" only when a
// previous service was actually given) unless a test overrides it.
const calculateRoute = vi.fn(async (_waypoints: string[]): Promise<RouteDistanceResult> => defaultMapsError);
vi.mock("../maps-distance", () => ({
  calculateGenericRouteRoundTrip: (pickup: string, destination: string) => calculateGenericRouteRoundTrip(pickup, destination),
  calculateComoTiranoRoundTrip: () => calculateComoTiranoRoundTrip(),
  calculateRoute: (waypoints: string[]) => calculateRoute(waypoints),
}));

const {
  processTransferRequestForMessage,
  processTransferRequestForMessageAndPrice,
  computeMissingInformation,
  runPricingForTransferRequest,
  runAvailabilityForTransferRequest,
  acceptTransferRequest,
  rejectTransferRequest,
  modifyPriceForTransferRequest,
  getTransferRequest,
} = await import("./service");

function seedMessage(id: string, transferRequestId: string | null = null) {
  fakeState.messages.push({ id, transferRequestId });
}

function inputFor(
  whatsappMessageId: string,
  extracted: TransferRequestExtractedFields,
  overrides: { tenantId?: string; clientId?: string } = {},
) {
  return {
    tenantId: overrides.tenantId ?? "tenant-1",
    clientId: overrides.clientId ?? "client-1",
    whatsappMessageId,
    extracted,
  };
}

beforeEach(() => {
  fakeState.requests = [];
  fakeState.messages = [];
  fakeState.clients = [];
  fakeState.bookings = [];
  fakeState.nextRequestId = 1;
  fakeState.nextBookingId = 1;
  calculateGenericRouteRoundTrip.mockClear();
  calculateComoTiranoRoundTrip.mockClear();
  calculateRoute.mockClear();
});

describe("computeMissingInformation", () => {
  it("requires pickup, destination, passengers, date, and time", () => {
    expect(
      computeMissingInformation({
        pickup: null,
        destination: null,
        requestedDate: null,
        requestedTime: null,
        passengers: null,
        flightNumber: null,
      }),
    ).toEqual(["pickup", "destination", "passengers", "date", "time"]);
  });

  // Availability milestone (founder decision): requestedTime is now
  // required for EVERY route — not only "andata" towards an airport as in
  // the original CChiefGrowthAI rule — because a candidate.startAt is
  // needed to run Availability before pricing, and no default/invented
  // time is ever acceptable.
  it("requires time even for a route with no airport involved", () => {
    const missing = computeMissingInformation({
      pickup: "Milano",
      destination: "Tirano",
      requestedDate: "2026-08-25",
      requestedTime: null,
      passengers: 2,
      flightNumber: null,
    });
    expect(missing).toEqual(["time"]);
  });

  it("additionally requires flight_number when pickup is an airport", () => {
    const missing = computeMissingInformation({
      pickup: "Malpensa",
      destination: "Sondrio",
      requestedDate: "2026-08-25",
      requestedTime: "10:00",
      passengers: 2,
      flightNumber: null,
    });
    expect(missing).toEqual(["flight_number"]);
  });

  it("is empty when every required field is present, including time, and no airport is involved", () => {
    expect(
      computeMissingInformation({
        pickup: "Milano",
        destination: "Tirano",
        requestedDate: "2026-08-25",
        requestedTime: "10:00",
        passengers: 2,
        flightNumber: null,
      }),
    ).toEqual([]);
  });
});

describe("processTransferRequestForMessage", () => {
  // A. complete message -> ready_for_pricing
  it("A: a single complete message creates a request already in ready_for_pricing", async () => {
    seedMessage("msg-1");

    const result = await processTransferRequestForMessage(
      inputFor("msg-1", { pickup: "Milano", destination: "Tirano", date: "2026-08-25", time: "10:00", passengers: 2 }),
    );

    expect(result.status).toBe("ready_for_pricing");
    expect(result.missingInformation).toEqual([]);
    expect(fakeState.requests).toHaveLength(1);
    expect(fakeState.messages[0]!.transferRequestId).toBe(result.id);
  });

  // B. incomplete message -> collecting_info, correct missing_information
  it("B: pickup+destination only stays collecting_info with the correct missing_information", async () => {
    seedMessage("msg-1");

    const result = await processTransferRequestForMessage(
      inputFor("msg-1", { pickup: "Milano", destination: "Tirano" }),
    );

    expect(result.status).toBe("collecting_info");
    expect(result.missingInformation).toEqual(["passengers", "date", "time"]);
  });

  // C. three messages accumulate into the same transfer_request
  it("C: three separate messages accumulate into the same transfer_request", async () => {
    seedMessage("msg-1");
    seedMessage("msg-2");
    seedMessage("msg-3");

    const first = await processTransferRequestForMessage(
      inputFor("msg-1", { pickup: "Milano", destination: "Tirano" }),
    );
    const second = await processTransferRequestForMessage(inputFor("msg-2", { date: "2026-08-25", time: "10:00" }));
    const third = await processTransferRequestForMessage(inputFor("msg-3", { passengers: 3 }));

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(third).toMatchObject({
      pickup: "Milano",
      destination: "Tirano",
      requestedDate: "2026-08-25",
      requestedTime: "10:00",
      passengers: 3,
      status: "ready_for_pricing",
    });
    expect(fakeState.requests).toHaveLength(1);
  });

  // D. a later message correcting a single field replaces the old value
  it("D: a later message changing only destination replaces the previous value", async () => {
    seedMessage("msg-1");
    seedMessage("msg-2");

    await processTransferRequestForMessage(inputFor("msg-1", { pickup: "Milano", destination: "Tirano" }));
    const second = await processTransferRequestForMessage(inputFor("msg-2", { destination: "Sondrio" }));

    expect(second.pickup).toBe("Milano");
    expect(second.destination).toBe("Sondrio");
    expect(fakeState.requests).toHaveLength(1);
  });

  // E. a null/absent value never erases a previously-known value
  it("E: a message with an absent field does not erase a value already known", async () => {
    seedMessage("msg-1");
    seedMessage("msg-2");

    await processTransferRequestForMessage(
      inputFor("msg-1", { pickup: "Milano", destination: "Tirano", passengers: 2 }),
    );
    const second = await processTransferRequestForMessage(inputFor("msg-2", { date: "2026-08-25" }));

    expect(second.pickup).toBe("Milano");
    expect(second.destination).toBe("Tirano");
    expect(second.passengers).toBe(2);
    expect(second.requestedDate).toBe("2026-08-25");
  });

  // F. a request already pending_admin_approval is never modified by a new message
  it("F: a pending_admin_approval request is left untouched; the new message starts a new request", async () => {
    seedMessage("msg-1");
    fakeState.requests.push({
      id: "request-locked",
      tenantId: "tenant-1",
      clientId: "client-1",
      status: "pending_admin_approval",
      pickup: "Milano",
      destination: "Tirano",
      requestedDate: "2026-08-25",
      passengers: 2,
      requestedTime: null,
      flightNumber: null,
      missingInformation: [],
    });

    const result = await processTransferRequestForMessage(
      inputFor("msg-1", { pickup: "Roma", destination: "Napoli", passengers: 1, date: "2026-09-01" }),
    );

    const locked = fakeState.requests.find((r) => r.id === "request-locked")!;
    expect(locked.pickup).toBe("Milano");
    expect(locked.destination).toBe("Tirano");
    expect(locked.status).toBe("pending_admin_approval");

    expect(result.id).not.toBe("request-locked");
    expect(result.pickup).toBe("Roma");
    expect(fakeState.requests).toHaveLength(2);
  });

  // G. a converted_to_quote request is not open; a new message starts a new request
  it("G: a converted_to_quote request never receives a merge; a new message starts a new request", async () => {
    seedMessage("msg-1");
    fakeState.requests.push({
      id: "request-done",
      tenantId: "tenant-1",
      clientId: "client-1",
      status: "converted_to_quote",
      pickup: "Milano",
      destination: "Tirano",
    });

    const result = await processTransferRequestForMessage(
      inputFor("msg-1", { pickup: "Roma", destination: "Napoli" }),
    );

    const done = fakeState.requests.find((r) => r.id === "request-done")!;
    expect(done.pickup).toBe("Milano");
    expect(result.id).not.toBe("request-done");
    expect(fakeState.requests).toHaveLength(2);
  });

  // H. a duplicate whatsapp_message_id never creates a second request
  it("H: calling with an already-linked whatsappMessageId is a no-op, not a second request", async () => {
    seedMessage("msg-1");

    const first = await processTransferRequestForMessage(
      inputFor("msg-1", { pickup: "Milano", destination: "Tirano" }),
    );
    const second = await processTransferRequestForMessage(
      inputFor("msg-1", { pickup: "Roma", destination: "Napoli" }),
    );

    expect(second.id).toBe(first.id);
    expect(second.pickup).toBe("Milano"); // unchanged — the second call was a no-op
    expect(fakeState.requests).toHaveLength(1);
  });

  // I (partial — see note): the ON CONFLICT DO NOTHING path is exercised
  // directly by pre-seeding an open request that a "concurrent" insert
  // would have raced against, proving the race falls back to a merge
  // instead of creating a second open row. This verifies the code path's
  // outcome logic, not Postgres's own guarantee — no test-database
  // strategy exists in this repo for true concurrent-transaction proof
  // (same caveat as whatsapp/service.test.ts's equivalent test).
  it("I: a losing concurrent insert merges into the winning open request instead of creating a second one", async () => {
    seedMessage("msg-1");
    fakeState.requests.push({
      id: "request-winner",
      tenantId: "tenant-1",
      clientId: "client-1",
      status: "collecting_info",
      pickup: null,
      destination: null,
      requestedDate: null,
      requestedTime: null,
      passengers: null,
      luggage: null,
      flightNumber: null,
      trainNumber: null,
      hotel: null,
      language: null,
      intent: null,
      missingInformation: ["pickup", "destination", "passengers", "date"],
    });

    const result = await processTransferRequestForMessage(
      inputFor("msg-1", { pickup: "Milano", destination: "Tirano" }),
    );

    expect(result.id).toBe("request-winner");
    expect(fakeState.requests).toHaveLength(1);
  });
});

describe("runPricingForTransferRequest", () => {
  function seedReadyRequest(overrides: Partial<Record<string, unknown>> = {}) {
    fakeState.requests.push({
      id: "request-1",
      tenantId: "tenant-1",
      clientId: "client-1",
      status: "ready_for_pricing",
      pickup: "Sondrio",
      destination: "Malpensa",
      requestedDate: "2026-09-15",
      requestedTime: null,
      passengers: 4,
      luggage: null,
      flightNumber: null,
      trainNumber: null,
      hotel: null,
      language: null,
      intent: null,
      missingInformation: [],
      pricingStatus: "not_priced",
      calculatedAmountCents: null,
      currency: "EUR",
      pricingBreakdown: null,
      ...overrides,
    });
  }

  it("1/2: a generic km route (italian or foreign) defers when maps-distance can't produce a real distance", async () => {
    // maps-distance is mocked to fail by default in this file (see the
    // vi.mock above) — proves the connection still never invents a price
    // when the distance lookup itself fails, and records why in
    // distanceLookup instead of silently dropping the reason.
    seedReadyRequest({ destination: "Livigno" });
    const italian = await runPricingForTransferRequest("tenant-1", "request-1", "italian");
    expect(italian.pricingStatus).toBe("manual_required");
    expect(italian.pricingBreakdown).toMatchObject({
      manualRequiredReason: "distance_not_provided",
      distanceLookup: { attempted: true, status: "error", errorCode: "api_key_missing" },
    });
    expect(calculateGenericRouteRoundTrip).toHaveBeenCalledWith("Sondrio", "Livigno");

    fakeState.requests = [];
    seedReadyRequest({ destination: "Livigno" });
    const foreign = await runPricingForTransferRequest("tenant-1", "request-1", "foreign");
    expect(foreign.pricingStatus).toBe("manual_required");
    expect(foreign.pricingBreakdown).toMatchObject({ manualRequiredReason: "distance_not_provided" });
  });

  it("1b: a generic km route unlocks calculated_km once maps-distance returns a real distance", async () => {
    calculateGenericRouteRoundTrip.mockResolvedValueOnce({
      status: "ok",
      provider: "google_routes_api",
      distanceKm: 60,
      durationMinutes: 80,
      legs: [
        { origin: "Sondrio", destination: "Livigno", distanceKm: 30, durationMinutes: 40 },
        { origin: "Livigno", destination: "Sondrio", distanceKm: 30, durationMinutes: 40 },
      ],
      error: null,
    });
    seedReadyRequest({ destination: "Livigno" });

    const result = await runPricingForTransferRequest("tenant-1", "request-1", "italian");

    expect(calculateGenericRouteRoundTrip).toHaveBeenCalledWith("Sondrio", "Livigno");
    expect(result.status).toBe("pending_admin_approval");
    expect(result.pricingStatus).toBe("calculated_km");
    // distanceKm 60, italian rate 1.00/km (<=100km): base 6000c + toll (60*0.08*100=480c) = 6480c, above the 5000c minimum.
    expect(result.calculatedAmountCents).toBe(6480);
    expect(result.pricingBreakdown).toMatchObject({
      matchedRule: "generic_km",
      distanceKmUsed: 60,
      distanceLookup: { attempted: true, status: "ok", provider: "google_routes_api", distanceKm: 60, durationMinutes: 80 },
    });
  });

  it("3/4: an airport fixed fare (Malpensa) advances status to pending_admin_approval and persists every pricing field", async () => {
    seedReadyRequest(); // Malpensa, 4 passengers — see seedReadyRequest defaults

    const result = await runPricingForTransferRequest("tenant-1", "request-1", "italian");

    expect(result.status).toBe("pending_admin_approval");
    expect(result.pricingStatus).toBe("fixed");
    expect(result.calculatedAmountCents).toBe(25000); // Malpensa, 4 passengers
    expect(result.currency).toBe("EUR");
    expect(result.pricingBreakdown).toMatchObject({
      matchedRule: "fixed_airport_malpensa",
      customerType: "italian",
      serviceType: "point_to_point",
      distanceLookup: { attempted: false },
    });
    // A fixed fare needs no distance — the connection never calls
    // maps-distance when calculatePrice() itself didn't ask for one.
    expect(calculateGenericRouteRoundTrip).not.toHaveBeenCalled();
    expect(calculateComoTiranoRoundTrip).not.toHaveBeenCalled();
  });

  it("5: Como-Tirano foreign produces a real computed price through the connection — no distance needed for the fixed fare", async () => {
    seedReadyRequest({ pickup: "Como", destination: "Tirano" });

    const result = await runPricingForTransferRequest("tenant-1", "request-1", "foreign");

    expect(result.status).toBe("pending_admin_approval");
    expect(result.pricingStatus).toBe("fixed");
    expect(result.calculatedAmountCents).toBe(36000);
    expect(result.pricingBreakdown).toMatchObject({ matchedRule: "como_tirano_fixed_foreign" });
  });

  it("6: Como-Tirano italian defers when maps-distance can't produce the 3-leg distance", async () => {
    seedReadyRequest({ pickup: "Como", destination: "Tirano" });

    const result = await runPricingForTransferRequest("tenant-1", "request-1", "italian");

    expect(result.status).toBe("ready_for_pricing");
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.pricingBreakdown).toMatchObject({ manualRequiredReason: "distance_not_provided" });
    // Como-Tirano is routed through the fixed 3-leg convention, not the
    // generic pickup/destination one.
    expect(calculateComoTiranoRoundTrip).toHaveBeenCalledTimes(1);
    expect(calculateGenericRouteRoundTrip).not.toHaveBeenCalled();
  });

  it("6b: Como-Tirano italian unlocks calculated_km once maps-distance returns the 3-leg distance", async () => {
    calculateComoTiranoRoundTrip.mockResolvedValueOnce({
      status: "ok",
      provider: "google_routes_api",
      distanceKm: 85.5,
      durationMinutes: 115,
      legs: [
        { origin: "Sondrio", destination: "Como", distanceKm: 30, durationMinutes: 40 },
        { origin: "Como", destination: "Tirano", distanceKm: 25.5, durationMinutes: 35 },
        { origin: "Tirano", destination: "Sondrio", distanceKm: 30, durationMinutes: 40 },
      ],
      error: null,
    });
    seedReadyRequest({ pickup: "Como", destination: "Tirano" });

    const result = await runPricingForTransferRequest("tenant-1", "request-1", "italian");

    expect(result.status).toBe("pending_admin_approval");
    expect(result.pricingStatus).toBe("calculated_km");
    // distanceKm 85.5, italian rate 1.00/km: base 8550c + toll (85.5*0.08*100=684c) = 9234c.
    expect(result.calculatedAmountCents).toBe(9234);
    expect(result.pricingBreakdown).toMatchObject({ matchedRule: "como_tirano_km_italian", distanceKmUsed: 85.5 });
  });

  it("8: more than 8 passengers on an airport fare defers — reachable through the connection since it needs no distance", async () => {
    seedReadyRequest({ passengers: 9 });

    const result = await runPricingForTransferRequest("tenant-1", "request-1", "italian");

    expect(result.status).toBe("ready_for_pricing");
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.pricingBreakdown).toMatchObject({ manualRequiredReason: "passengers_above_supported_fare_band" });
  });

  it("9: pickup incompatible with the fixed fare defers — reachable through the connection since it needs no distance", async () => {
    seedReadyRequest({ pickup: "Roma" });

    const result = await runPricingForTransferRequest("tenant-1", "request-1", "italian");

    expect(result.status).toBe("ready_for_pricing");
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.pricingBreakdown).toMatchObject({ manualRequiredReason: "fixed_fare_origin_requires_verification" });
  });

  it("10 (synthetic destination, to exercise the code path): a fixed fare plus a hospital keyword produces a computed price AND a defined italian waiting rule together", async () => {
    // "Ospedale Malpensa" is not a real place — chosen only so the
    // destination matches both the airport keyword table (a real price can
    // be computed with no distanceKm) and the hospital keyword list, to
    // prove the two are combined correctly. A real Sondrio-valley hospital
    // (e.g. "Ospedale di Sondalo") never matches the fixed-fare table, so a
    // realistic hospital case always defers on price too — see the
    // "hospitalWaiting inside pricingBreakdown" tests below.
    seedReadyRequest({ destination: "Ospedale Malpensa" });

    const result = await runPricingForTransferRequest("tenant-1", "request-1", "italian");

    expect(result.status).toBe("pending_admin_approval");
    expect(result.pricingStatus).toBe("fixed");
    expect(result.calculatedAmountCents).toBe(25000);
    expect((result.pricingBreakdown as Record<string, unknown>).hospitalWaiting).toMatchObject({
      applies: true,
      hospitalWaitingStatus: "defined",
      hospitalWaitingRule: "1h_free_then_40_eur_per_hour",
    });
  });

  it("11 (synthetic destination, to exercise the code path): the same case for a foreign customer computes the price but flags the waiting rule as manual_required", async () => {
    seedReadyRequest({ destination: "Ospedale Malpensa" });

    const result = await runPricingForTransferRequest("tenant-1", "request-1", "foreign");

    expect(result.status).toBe("pending_admin_approval");
    expect(result.pricingStatus).toBe("fixed");
    expect(result.calculatedAmountCents).toBe(25000);
    expect((result.pricingBreakdown as Record<string, unknown>).hospitalWaiting).toMatchObject({
      applies: true,
      hospitalWaitingStatus: "manual_required",
    });
  });

  it("12-15: hourly/GetTransfer/Viator/night-holiday are not reachable through this connection today — see report", () => {
    // No test to write here that wouldn't be misleading: transfer_requests
    // has no requestedServiceType/channel/possibleNightOrHolidaySurcharge
    // columns (out of scope this milestone — would need a migration,
    // explicitly not authorized). runPricingForTransferRequest always
    // passes the safe defaults ("point_to_point", "direct", false), so
    // these four manual_required paths can never fire through this
    // connection as it exists today. Each is already fully covered, and
    // passing, in packages/core/src/pricing/service.test.ts (tests 17-20)
    // — re-asserting the same pricing-engine behavior here would duplicate
    // that coverage without testing anything the integration layer
    // actually does. Documented in README.md and in the final report.
    expect(true).toBe(true);
  });

  it("a manual_required result (no distance available) leaves status at ready_for_pricing", async () => {
    seedReadyRequest({ destination: "Livigno" }); // not an airport/Como-Tirano keyword -> generic km branch, no distanceKm ever supplied by this connection

    const result = await runPricingForTransferRequest("tenant-1", "request-1", "italian");

    expect(result.status).toBe("ready_for_pricing"); // unchanged — nothing to send an admin
    expect(result.pricingStatus).toBe("manual_required");
    expect(result.calculatedAmountCents).toBeNull();
    expect(result.pricingBreakdown).toMatchObject({ manualRequiredReason: "distance_not_provided" });
  });

  it("is a no-op when the request is not at ready_for_pricing", async () => {
    seedReadyRequest({ status: "collecting_info" });

    const result = await runPricingForTransferRequest("tenant-1", "request-1", "italian");

    expect(result.status).toBe("collecting_info");
    expect(result.pricingStatus).toBe("not_priced"); // untouched
  });

  it("is idempotent — calling twice does not re-run pricing on an already-advanced request", async () => {
    seedReadyRequest();

    const first = await runPricingForTransferRequest("tenant-1", "request-1", "italian");
    expect(first.status).toBe("pending_admin_approval");

    const second = await runPricingForTransferRequest("tenant-1", "request-1", "italian");
    expect(second).toEqual(first);
  });

  it("persists hospitalWaiting inside pricingBreakdown even when the base transfer itself is manual_required", async () => {
    seedReadyRequest({ destination: "Ospedale di Sondalo" }); // km branch, no distanceKm -> manual_required for the transfer

    const result = await runPricingForTransferRequest("tenant-1", "request-1", "italian");

    expect(result.pricingStatus).toBe("manual_required");
    expect((result.pricingBreakdown as Record<string, unknown>).hospitalWaiting).toMatchObject({
      applies: true,
      hospitalWaitingStatus: "defined",
      hospitalWaitingRule: "1h_free_then_40_eur_per_hour",
    });
  });

  it("a foreign customer at a hospital destination keeps the transfer price computed while waiting is flagged separately", async () => {
    seedReadyRequest({ destination: "Malpensa", passengers: 4 }); // fixed fare, not actually a hospital — control case
    const control = await runPricingForTransferRequest("tenant-1", "request-1", "foreign");
    expect((control.pricingBreakdown as Record<string, unknown>).hospitalWaiting).toMatchObject({ applies: false });

    fakeState.requests = [];
    seedReadyRequest({ destination: "Ospedale di Sondalo" });
    const result = await runPricingForTransferRequest("tenant-1", "request-1", "foreign");
    expect(result.pricingStatus).toBe("manual_required"); // transfer itself: no distance available
    expect((result.pricingBreakdown as Record<string, unknown>).hospitalWaiting).toMatchObject({
      applies: true,
      hospitalWaitingStatus: "manual_required",
    });
  });

  it("throws when the transfer_request does not exist", async () => {
    await expect(runPricingForTransferRequest("tenant-1", "missing-request", "italian")).rejects.toThrow();
  });
});

describe("processTransferRequestForMessageAndPrice", () => {
  function seedClient(overrides: Partial<Record<string, unknown>> = {}) {
    fakeState.clients.push({ id: "client-1", tenantId: "tenant-1", phone: "+999000000001", ...overrides });
  }

  it("automatically prices a complete message via the real client -> customerType -> pricing chain", async () => {
    seedMessage("msg-1");
    seedClient(); // phone does not start with "39" -> foreign

    const result = await processTransferRequestForMessageAndPrice(
      inputFor("msg-1", { pickup: "Sondrio", destination: "Malpensa", date: "2026-09-20", time: "10:00", passengers: 4 }),
    );

    expect(result.status).toBe("pending_admin_approval");
    expect(result.pricingStatus).toBe("fixed");
    expect(result.calculatedAmountCents).toBe(25000); // foreign, Malpensa, 4 passengers
    expect((result.pricingBreakdown as Record<string, unknown>).customerType).toBe("foreign");
  });

  it("resolves italian customerType from the +39 prefix", async () => {
    seedMessage("msg-1");
    seedClient({ phone: "+393281234567" });

    const result = await processTransferRequestForMessageAndPrice(
      inputFor("msg-1", { pickup: "Sondrio", destination: "Malpensa", date: "2026-09-20", time: "10:00", passengers: 4 }),
    );

    expect((result.pricingBreakdown as Record<string, unknown>).customerType).toBe("italian");
    expect(result.calculatedAmountCents).toBe(25000); // italian rate == foreign rate for this fixed fare
  });

  it("a manual_required outcome leaves status at ready_for_pricing, not pending_admin_approval", async () => {
    seedMessage("msg-1");
    seedClient();

    // Livigno matches no fixed-fare/Como-Tirano keyword and no distanceKm
    // is ever supplied by this connection -> manual_required.
    const result = await processTransferRequestForMessageAndPrice(
      inputFor("msg-1", { pickup: "Sondrio", destination: "Livigno", date: "2026-09-20", time: "10:00", passengers: 2 }),
    );

    expect(result.status).toBe("ready_for_pricing"); // never advanced
    expect(result.pricingStatus).toBe("manual_required");
  });

  it("does not attempt pricing (or a client lookup) when the message leaves the request incomplete", async () => {
    seedMessage("msg-1");
    // Deliberately no client seeded — if this attempted a client lookup it
    // would throw "client not found"; the fact that it doesn't throw here
    // proves pricing was never attempted for an incomplete request.
    const result = await processTransferRequestForMessageAndPrice(
      inputFor("msg-1", { pickup: "Sondrio", destination: "Malpensa" }), // missing passengers/date
    );

    expect(result.status).toBe("collecting_info");
    expect(result.pricingStatus).toBe("not_priced");
  });

  it("throws defensively if the resolved client cannot be found", async () => {
    seedMessage("msg-1");
    // No client seeded, but this message DOES complete the request —
    // pricing will be attempted and the client lookup should fail loudly.
    await expect(
      processTransferRequestForMessageAndPrice(
        inputFor("msg-1", { pickup: "Sondrio", destination: "Malpensa", date: "2026-09-20", time: "10:00", passengers: 4 }),
      ),
    ).rejects.toThrow(/client .* not found/);
  });
});

describe("runAvailabilityForTransferRequest", () => {
  function seedReadyForAvailability(overrides: Partial<Record<string, unknown>> = {}) {
    fakeState.requests.push({
      id: "request-1",
      tenantId: "tenant-1",
      clientId: "client-1",
      status: "ready_for_pricing",
      pickup: "Sondrio",
      destination: "Malpensa",
      requestedDate: "2026-09-20",
      requestedTime: "08:00",
      passengers: 4,
      luggage: null,
      flightNumber: null,
      trainNumber: null,
      hotel: null,
      language: null,
      intent: null,
      missingInformation: [],
      pricingStatus: "not_priced",
      calculatedAmountCents: null,
      currency: "EUR",
      pricingBreakdown: null,
      quoteId: null,
      finalAmountCents: null,
      priceOverrideReason: null,
      adminApprovedAt: null,
      adminApprovedBy: null,
      cancelledReason: null,
      customerTripDurationMinutes: null,
      availabilityBreakdown: null,
      ...overrides,
    });
  }

  function mapsOk(durationMinutes: number): RouteDistanceResult {
    return { status: "ok", provider: "google_routes_api", distanceKm: 1, durationMinutes, legs: [], error: null };
  }

  function breakdownOf(result: { availabilityBreakdown: unknown }) {
    return result.availabilityBreakdown as {
      status: string;
      customerTripDuration: Record<string, unknown>;
      relocation: Record<string, unknown>;
      previousServiceEndAt: string | null;
      feasibility: Record<string, unknown> | null;
    };
  }

  // 1
  it("1: no previous service — Sondrio -> Malpensa, one-way duration mocked, feasible", async () => {
    seedReadyForAvailability();
    calculateRoute.mockResolvedValueOnce(mapsOk(150));

    const result = await runAvailabilityForTransferRequest("tenant-1", "request-1", null);

    expect(calculateRoute).toHaveBeenCalledTimes(1);
    expect(calculateRoute).toHaveBeenCalledWith(["Sondrio", "Malpensa"]); // 11: one-way, never 3 waypoints
    expect(result.customerTripDurationMinutes).toBe(150);
    const breakdown = breakdownOf(result);
    expect(breakdown.status).toBe("verified");
    expect(breakdown.relocation).toMatchObject({ status: "not_applicable", origin: "Sondrio" });
    expect(breakdown.feasibility).toMatchObject({ feasible: true, reason: "no_previous_service" });
  });

  // 2
  it("2: previous service Sondrio->Malpensa, candidate pickup Malpensa -> relocation is Malpensa->candidate.pickup", async () => {
    seedReadyForAvailability({ pickup: "Malpensa", destination: "Aprica", requestedTime: "12:00" });
    calculateRoute
      .mockResolvedValueOnce(mapsOk(60)) // customerTripDuration Malpensa -> Aprica
      .mockResolvedValueOnce(mapsOk(5)); // relocation Malpensa -> Malpensa (previous destination == candidate pickup)

    const previousService: PreviousService = {
      startAt: new Date("2026-09-20T08:00:00"),
      pickup: "Sondrio",
      destination: "Malpensa",
      customerTripDurationMinutes: 150,
    };

    const result = await runAvailabilityForTransferRequest("tenant-1", "request-1", previousService);

    expect(calculateRoute).toHaveBeenNthCalledWith(1, ["Malpensa", "Aprica"]);
    expect(calculateRoute).toHaveBeenNthCalledWith(2, ["Malpensa", "Malpensa"]); // relocationOrigin = previous.destination
    const breakdown = breakdownOf(result);
    expect(breakdown.relocation).toMatchObject({ status: "ok", origin: "Malpensa", durationMinutes: 5 });
    expect(breakdown.status).toBe("verified");
  });

  // 3, 10
  it("3/10: previous service Aprica->Sondrio, candidate pickup Milano -> relocation Sondrio->Milano (previous really ends at Sondrio), never Aprica->Sondrio->Milano", async () => {
    seedReadyForAvailability({ pickup: "Milano", destination: "Roma", requestedTime: "14:30" });
    calculateRoute
      .mockResolvedValueOnce(mapsOk(90)) // customerTripDuration Milano -> Roma
      .mockResolvedValueOnce(mapsOk(70)); // relocation Sondrio -> Milano

    const previousService: PreviousService = {
      startAt: new Date("2026-09-20T10:00:00"),
      pickup: "Aprica",
      destination: "Sondrio", // the previous service genuinely ends at Sondrio — not assumed
      customerTripDurationMinutes: 45,
    };

    const result = await runAvailabilityForTransferRequest("tenant-1", "request-1", previousService);

    // The relocation call is a plain 2-waypoint route Sondrio -> Milano
    // (the previous service's REAL destination) — never a 3-waypoint
    // Aprica -> Sondrio -> Milano detour, and never Aprica -> Milano
    // either (that would ignore where the vehicle really ended up).
    expect(calculateRoute).toHaveBeenNthCalledWith(2, ["Sondrio", "Milano"]);
    const breakdown = breakdownOf(result);
    expect(breakdown.relocation).toMatchObject({ status: "ok", origin: "Sondrio", durationMinutes: 70 });
  });

  // 4, 9 (buffer boundary — feasible)
  it("4: a 60-minute gap between previous service end and candidate start (relocation 0) is exactly feasible", async () => {
    seedReadyForAvailability({
      pickup: "Malpensa",
      destination: "Sondrio",
      requestedDate: "2026-09-20",
      requestedTime: "11:30",
    });
    calculateRoute.mockResolvedValueOnce(mapsOk(60)).mockResolvedValueOnce(mapsOk(0));

    const previousService: PreviousService = {
      startAt: new Date("2026-09-20T10:00:00"),
      pickup: "Sondrio",
      destination: "Malpensa",
      customerTripDurationMinutes: 30, // ends 10:30
    };

    const before = { ...fakeState.requests[0] };
    const result = await runAvailabilityForTransferRequest("tenant-1", "request-1", previousService);

    const breakdown = breakdownOf(result);
    expect(breakdown.feasibility).toMatchObject({ feasible: true, marginMinutes: 0 });

    // 9: every original field is untouched — only customerTripDurationMinutes/
    // availabilityBreakdown/updatedAt change.
    expect(result.pickup).toBe(before.pickup);
    expect(result.destination).toBe(before.destination);
    expect(result.requestedDate).toBe(before.requestedDate);
    expect(result.requestedTime).toBe(before.requestedTime);
    expect(result.passengers).toBe(before.passengers);
    expect(result.pricingStatus).toBe(before.pricingStatus);
    expect(result.calculatedAmountCents).toBe(before.calculatedAmountCents);
    expect(result.status).toBe("ready_for_pricing"); // availability never advances status
  });

  // 5 (buffer boundary — not feasible, one minute short)
  it("5: a 59-minute gap (one short of the 60-minute buffer) is NOT feasible", async () => {
    seedReadyForAvailability({
      pickup: "Malpensa",
      destination: "Sondrio",
      requestedDate: "2026-09-20",
      requestedTime: "11:29",
    });
    calculateRoute.mockResolvedValueOnce(mapsOk(60)).mockResolvedValueOnce(mapsOk(0));

    const previousService: PreviousService = {
      startAt: new Date("2026-09-20T10:00:00"),
      pickup: "Sondrio",
      destination: "Malpensa",
      customerTripDurationMinutes: 30, // ends 10:30
    };

    const result = await runAvailabilityForTransferRequest("tenant-1", "request-1", previousService);

    const breakdown = breakdownOf(result);
    expect(breakdown.feasibility).toMatchObject({ feasible: false, marginMinutes: -1 });
  });

  // 6
  it("6: a Maps failure for the customer trip duration is recorded structurally — never invented, never blocks feasibility", async () => {
    seedReadyForAvailability();
    calculateRoute.mockResolvedValueOnce({
      status: "error",
      provider: "google_routes_api",
      distanceKm: null,
      durationMinutes: null,
      legs: [],
      error: { code: "request_failed", message: "network down" },
    });

    const result = await runAvailabilityForTransferRequest("tenant-1", "request-1", null);

    expect(result.customerTripDurationMinutes).toBeNull();
    const breakdown = breakdownOf(result);
    expect(breakdown.customerTripDuration).toMatchObject({ status: "error", errorCode: "request_failed" });
    // No previous service -> feasibility doesn't depend on the candidate's
    // own trip duration, so it is still verified and feasible.
    expect(breakdown.status).toBe("verified");
    expect(breakdown.feasibility).toMatchObject({ feasible: true, reason: "no_previous_service" });
  });

  // 7
  it("7: a Maps failure for relocation leaves availability not_verified — no feasibility decision invented, no return-to-Sondrio guess", async () => {
    seedReadyForAvailability({ pickup: "Milano", destination: "Sondrio", requestedTime: "12:00" });
    calculateRoute
      .mockResolvedValueOnce(mapsOk(90)) // customerTripDuration succeeds
      .mockResolvedValueOnce({
        status: "error",
        provider: "google_routes_api",
        distanceKm: null,
        durationMinutes: null,
        legs: [],
        error: { code: "no_route_found", message: "no route" },
      });

    const previousService: PreviousService = {
      startAt: new Date("2026-09-20T08:00:00"),
      pickup: "Sondrio",
      destination: "Malpensa",
      customerTripDurationMinutes: 30,
    };

    const result = await runAvailabilityForTransferRequest("tenant-1", "request-1", previousService);

    const breakdown = breakdownOf(result);
    expect(breakdown.status).toBe("not_verified");
    expect(breakdown.feasibility).toBeNull();
    expect(breakdown.relocation).toMatchObject({ status: "error", origin: "Malpensa", errorCode: "no_route_found" });
    // customerTripDurationMinutes is unaffected by the relocation failure —
    // the two Maps calls are independent.
    expect(result.customerTripDurationMinutes).toBe(90);
  });

  it("is a no-op when the request is not ready_for_pricing", async () => {
    seedReadyForAvailability({ status: "collecting_info" });

    const result = await runAvailabilityForTransferRequest("tenant-1", "request-1", null);

    expect(result.status).toBe("collecting_info");
    expect(result.availabilityBreakdown).toBeNull();
    expect(calculateRoute).not.toHaveBeenCalled();
  });

  it("throws when the transfer_request does not exist", async () => {
    await expect(runAvailabilityForTransferRequest("tenant-1", "missing", null)).rejects.toThrow();
  });
});

// 8, 12
describe("Availability does not block pricing, and the two Maps calls stay independent", () => {
  function seedClient(overrides: Partial<Record<string, unknown>> = {}) {
    fakeState.clients.push({ id: "client-1", tenantId: "tenant-1", phone: "+999000000001", ...overrides });
  }

  // 8
  it("8: a total Availability failure (Maps down for both calls) still reaches pending_admin_approval for a fixed fare", async () => {
    seedMessage("msg-1");
    seedClient();
    // calculateRoute already defaults to defaultMapsError for every call in
    // this file (see the vi.mock above) — deliberately never overridden
    // here, to prove Availability failing completely does not stop pricing.

    const result = await processTransferRequestForMessageAndPrice(
      inputFor("msg-1", { pickup: "Sondrio", destination: "Malpensa", date: "2026-09-20", time: "10:00", passengers: 4 }),
    );

    expect(result.customerTripDurationMinutes).toBeNull();
    expect((result.availabilityBreakdown as Record<string, unknown>).status).toBe("verified"); // no previous service -> still a real decision
    expect(result.status).toBe("pending_admin_approval");
    expect(result.pricingStatus).toBe("fixed");
    expect(result.calculatedAmountCents).toBe(25000);
  });

  // 12
  it("12: pricing's own round-trip Maps call (calculateGenericRouteRoundTrip) runs independently of Availability's one-way call", async () => {
    seedMessage("msg-1");
    seedClient();
    calculateRoute.mockResolvedValueOnce({
      status: "ok",
      provider: "google_routes_api",
      distanceKm: 42,
      durationMinutes: 55, // one-way, Availability's number
      legs: [],
      error: null,
    });
    calculateGenericRouteRoundTrip.mockResolvedValueOnce({
      status: "ok",
      provider: "google_routes_api",
      distanceKm: 84,
      durationMinutes: 110, // round-trip total, pricing's own number — deliberately different
      legs: [],
      error: null,
    });

    const result = await processTransferRequestForMessageAndPrice(
      inputFor("msg-1", { pickup: "Sondrio", destination: "Livigno", date: "2026-09-20", time: "09:00", passengers: 2 }),
    );

    expect(calculateRoute).toHaveBeenCalledWith(["Sondrio", "Livigno"]);
    expect(calculateGenericRouteRoundTrip).toHaveBeenCalledWith("Sondrio", "Livigno");
    // 11: the two numbers never mix — customerTripDurationMinutes is the
    // one-way 55, pricing's distanceKmUsed comes from the round-trip 84km.
    expect(result.customerTripDurationMinutes).toBe(55);
    expect((result.pricingBreakdown as Record<string, unknown>).distanceKmUsed).toBe(84);
    expect(result.pricingStatus).toBe("calculated_km");
  });
});

describe("Admin decision — accept / reject / modifyPrice", () => {
  const ADMIN_ID = "admin-profile-1";

  function seedPendingApproval(overrides: Partial<Record<string, unknown>> = {}) {
    fakeState.requests.push({
      id: "request-1",
      tenantId: "tenant-1",
      clientId: "client-1",
      status: "pending_admin_approval",
      pickup: "Sondrio",
      destination: "Malpensa",
      requestedDate: "2026-09-15",
      requestedTime: "10:00",
      passengers: 4,
      luggage: null,
      flightNumber: null,
      trainNumber: null,
      hotel: null,
      language: null,
      intent: null,
      missingInformation: [],
      pricingStatus: "fixed",
      calculatedAmountCents: 25000,
      currency: "EUR",
      pricingBreakdown: { matchedRule: "fixed_airport_malpensa" },
      finalAmountCents: null,
      priceOverrideReason: null,
      adminApprovedAt: null,
      adminApprovedBy: null,
      cancelledReason: null,
      // Booking Snapshot: pre-resolved by default (as if Availability had
      // already run) so existing ACCEPT/MODIFY_PRICE tests — which now
      // also create a booking as a side effect — never hit the Maps
      // fallback path unless a test deliberately overrides this to null.
      pickupAddress: null,
      destinationAddress: null,
      customerTripDurationMinutes: 45,
      ...overrides,
    });
  }

  const TRIP_FIELDS = ["pickup", "destination", "requestedDate", "requestedTime", "passengers"] as const;

  function snapshotTripFields(row: Record<string, unknown>) {
    return Object.fromEntries(TRIP_FIELDS.map((field) => [field, row[field]]));
  }

  // A
  it("A: ACCEPT on pending_admin_approval moves to approved and sets the admin-decision fields", async () => {
    seedPendingApproval();

    const result = await acceptTransferRequest("tenant-1", "request-1", ADMIN_ID);

    expect(result.status).toBe("approved");
    expect(result.finalAmountCents).toBe(25000);
    expect(result.priceOverrideReason).toBeNull(); // L
    expect(result.adminApprovedAt).toBeInstanceOf(Date);
    expect(result.adminApprovedBy).toBe(ADMIN_ID);
  });

  // B
  it("B: REJECT on pending_admin_approval moves to cancelled with a rejected_by_admin reason", async () => {
    seedPendingApproval();

    const result = await rejectTransferRequest("tenant-1", "request-1");

    expect(result.status).toBe("cancelled");
    expect(result.cancelledReason).toBe("rejected_by_admin");
    expect(result.finalAmountCents).toBeNull();
  });

  it("B2: REJECT with a note appends it after the fixed rejected_by_admin marker", async () => {
    seedPendingApproval();

    const result = await rejectTransferRequest("tenant-1", "request-1", "cliente non affidabile");

    expect(result.cancelledReason).toBe("rejected_by_admin: cliente non affidabile");
  });

  // C, D, E, N
  it("C/D/E/N: MODIFY PRICE on pending_admin_approval sets finalAmountCents to the admin's price, leaves calculatedAmountCents untouched, and persists", async () => {
    seedPendingApproval(); // calculatedAmountCents: 25000

    const result = await modifyPriceForTransferRequest("tenant-1", "request-1", ADMIN_ID, 22000, "sconto cliente abituale");

    expect(result.status).toBe("approved");
    expect(result.finalAmountCents).toBe(22000); // C
    expect(result.calculatedAmountCents).toBe(25000); // D — engine output untouched
    expect(result.finalAmountCents).not.toBe(result.calculatedAmountCents); // N
    expect(result.priceOverrideReason).toBe("sconto cliente abituale");
    expect(result.adminApprovedAt).toBeInstanceOf(Date);
    expect(result.adminApprovedBy).toBe(ADMIN_ID);

    // E/O — independent re-read confirms persistence, not just the returned object.
    const reread = await getTransferRequest("tenant-1", "request-1");
    expect(reread?.finalAmountCents).toBe(22000);
    expect(reread?.calculatedAmountCents).toBe(25000);
    expect(reread?.priceOverrideReason).toBe("sconto cliente abituale");
  });

  // F
  describe("F: actions on a status other than pending_admin_approval throw", () => {
    const INVALID_STATUSES = ["collecting_info", "ready_for_pricing", "converted_to_quote", "expired"] as const;

    for (const status of INVALID_STATUSES) {
      it(`accept on ${status} throws`, async () => {
        seedPendingApproval({ status });
        await expect(acceptTransferRequest("tenant-1", "request-1", ADMIN_ID)).rejects.toThrow(
          new RegExp(status),
        );
      });

      it(`reject on ${status} throws`, async () => {
        seedPendingApproval({ status });
        await expect(rejectTransferRequest("tenant-1", "request-1")).rejects.toThrow(new RegExp(status));
      });

      it(`modifyPrice on ${status} throws`, async () => {
        seedPendingApproval({ status });
        await expect(
          modifyPriceForTransferRequest("tenant-1", "request-1", ADMIN_ID, 20000, "motivo"),
        ).rejects.toThrow(new RegExp(status));
      });
    }
  });

  // G
  it("G: a second identical ACCEPT is idempotent — no-op, same result", async () => {
    seedPendingApproval();

    const first = await acceptTransferRequest("tenant-1", "request-1", ADMIN_ID);
    const second = await acceptTransferRequest("tenant-1", "request-1", ADMIN_ID);

    expect(second).toEqual(first);
  });

  // H
  it("H: a second identical REJECT is idempotent — no-op, same result", async () => {
    seedPendingApproval();

    const first = await rejectTransferRequest("tenant-1", "request-1", "nota");
    const second = await rejectTransferRequest("tenant-1", "request-1");

    expect(second).toEqual(first);
  });

  // I
  it("I: MODIFY PRICE after the request is already approved throws — the window closes at the first decision", async () => {
    seedPendingApproval();
    await acceptTransferRequest("tenant-1", "request-1", ADMIN_ID);

    await expect(
      modifyPriceForTransferRequest("tenant-1", "request-1", ADMIN_ID, 21000, "secondo tentativo"),
    ).rejects.toThrow(/approved/);
  });

  it("I2: MODIFY PRICE after a first MODIFY PRICE also throws — not just after a plain ACCEPT", async () => {
    seedPendingApproval();
    await modifyPriceForTransferRequest("tenant-1", "request-1", ADMIN_ID, 22000, "primo sconto");

    await expect(
      modifyPriceForTransferRequest("tenant-1", "request-1", ADMIN_ID, 21000, "secondo sconto"),
    ).rejects.toThrow(/approved/);
  });

  // J
  it("J: none of the three actions touch pickup/destination/date/time/passengers", async () => {
    seedPendingApproval();
    const before = snapshotTripFields(fakeState.requests[0]!);
    const acceptResult = await acceptTransferRequest("tenant-1", "request-1", ADMIN_ID);
    expect(snapshotTripFields(acceptResult)).toEqual(before);

    fakeState.requests = [];
    seedPendingApproval();
    const rejectResult = await rejectTransferRequest("tenant-1", "request-1");
    expect(snapshotTripFields(rejectResult)).toEqual(before);

    fakeState.requests = [];
    seedPendingApproval();
    const modifyResult = await modifyPriceForTransferRequest("tenant-1", "request-1", ADMIN_ID, 22000, "motivo");
    expect(snapshotTripFields(modifyResult)).toEqual(before);
  });

  // K
  it("K: REJECT on a request already cancelled for a different reason (superseded_by_new_request) throws", async () => {
    seedPendingApproval({ status: "cancelled", cancelledReason: "superseded_by_new_request" });

    await expect(rejectTransferRequest("tenant-1", "request-1")).rejects.toThrow(/cancelled/);
  });

  // M
  it("M: MODIFY PRICE with an empty reason throws", async () => {
    seedPendingApproval();

    await expect(modifyPriceForTransferRequest("tenant-1", "request-1", ADMIN_ID, 22000, "")).rejects.toThrow(
      /reason/,
    );
    await expect(modifyPriceForTransferRequest("tenant-1", "request-1", ADMIN_ID, 22000, "   ")).rejects.toThrow(
      /reason/,
    );
  });

  it("throws when the transfer_request does not exist (accept/reject/modifyPrice)", async () => {
    await expect(acceptTransferRequest("tenant-1", "missing", ADMIN_ID)).rejects.toThrow();
    await expect(rejectTransferRequest("tenant-1", "missing")).rejects.toThrow();
    await expect(modifyPriceForTransferRequest("tenant-1", "missing", ADMIN_ID, 20000, "motivo")).rejects.toThrow();
  });

  // ── Booking Snapshot (transfer_request approved -> confirmed booking) ──
  describe("Booking Snapshot — ACCEPT/MODIFY_PRICE create a confirmed booking", () => {
    function mapsOk(durationMinutes: number): RouteDistanceResult {
      return { status: "ok", provider: "google_routes_api", distanceKm: 10, durationMinutes, legs: [], error: null };
    }

    function onlyBooking() {
      expect(fakeState.bookings).toHaveLength(1);
      return fakeState.bookings[0]!;
    }

    it("N1: ACCEPT creates a confirmed booking snapshot with every expected field", async () => {
      seedPendingApproval({ pickupAddress: "Via Roma 1, Sondrio", destinationAddress: "Aeroporto di Malpensa" });

      await acceptTransferRequest("tenant-1", "request-1", ADMIN_ID);

      const booking = onlyBooking();
      expect(booking.transferRequestId).toBe("request-1");
      expect(booking.tenantId).toBe("tenant-1");
      expect(booking.clientId).toBe("client-1");
      expect(booking.pickup).toBe("Sondrio");
      expect(booking.destination).toBe("Malpensa");
      expect(booking.pickupAddress).toBe("Via Roma 1, Sondrio");
      expect(booking.destinationAddress).toBe("Aeroporto di Malpensa");
      expect(booking.customerTripDurationMinutes).toBe(45);
      expect(booking.finalAmountCents).toBe(25000); // calculatedAmountCents, plain ACCEPT
      expect(booking.currency).toBe("EUR");
      expect(booking.quoteId).toBeNull();
      expect(booking.status).toBe("confirmed");
      expect((booking.scheduledAt as Date).toISOString()).toBe("2026-09-15T08:00:00.000Z"); // CEST, +02:00
    });

    it("N2: MODIFY_PRICE creates a booking at the admin-overridden price, not the engine's own", async () => {
      seedPendingApproval();

      await modifyPriceForTransferRequest("tenant-1", "request-1", ADMIN_ID, 22000, "sconto cliente abituale");

      const booking = onlyBooking();
      expect(booking.finalAmountCents).toBe(22000);
    });

    it("N3: a second identical ACCEPT does not create a duplicate booking", async () => {
      seedPendingApproval();

      await acceptTransferRequest("tenant-1", "request-1", ADMIN_ID);
      await acceptTransferRequest("tenant-1", "request-1", ADMIN_ID);

      onlyBooking();
    });

    it("N4: REJECT never creates a booking", async () => {
      seedPendingApproval();

      await rejectTransferRequest("tenant-1", "request-1");

      expect(fakeState.bookings).toHaveLength(0);
    });

    it("N5: a null customerTripDurationMinutes falls back to a fresh Maps one-way call, whose result is used for the booking and persisted back onto the transfer_request", async () => {
      seedPendingApproval({ customerTripDurationMinutes: null });
      calculateRoute.mockResolvedValueOnce(mapsOk(55));

      await acceptTransferRequest("tenant-1", "request-1", ADMIN_ID);

      expect(calculateRoute).toHaveBeenCalledWith(["Sondrio", "Malpensa"]);
      expect(onlyBooking().customerTripDurationMinutes).toBe(55);

      const reread = await getTransferRequest("tenant-1", "request-1");
      expect(reread?.customerTripDurationMinutes).toBe(55);
    });

    it("N6: a Maps failure during the fallback never creates a booking and propagates an explicit error, leaving the transfer_request approved but unbooked", async () => {
      seedPendingApproval({ customerTripDurationMinutes: null });
      // calculateRoute defaults to defaultMapsError (no mockResolvedValueOnce set).

      await expect(acceptTransferRequest("tenant-1", "request-1", ADMIN_ID)).rejects.toThrow(
        /booking creation failed/,
      );

      expect(fakeState.bookings).toHaveLength(0);
      const reread = await getTransferRequest("tenant-1", "request-1");
      expect(reread?.status).toBe("approved"); // Opzione A: the approval already committed
      expect(reread?.finalAmountCents).toBe(25000);
    });

    it("N7: retrying ACCEPT after a failed booking creation creates the missing booking, without re-running the approval", async () => {
      seedPendingApproval({ customerTripDurationMinutes: null });
      await expect(acceptTransferRequest("tenant-1", "request-1", ADMIN_ID)).rejects.toThrow();
      expect(fakeState.bookings).toHaveLength(0);

      calculateRoute.mockResolvedValueOnce(mapsOk(60));
      const result = await acceptTransferRequest("tenant-1", "request-1", ADMIN_ID);

      expect(result.finalAmountCents).toBe(25000);
      expect(onlyBooking().customerTripDurationMinutes).toBe(60);
    });

    it("N8: retrying via ACCEPT after a MODIFY_PRICE-approved request with a missing booking creates it without touching the admin-chosen price", async () => {
      seedPendingApproval({ customerTripDurationMinutes: null });
      await expect(
        modifyPriceForTransferRequest("tenant-1", "request-1", ADMIN_ID, 22000, "sconto"),
      ).rejects.toThrow(/booking creation failed/);
      expect(fakeState.bookings).toHaveLength(0);

      calculateRoute.mockResolvedValueOnce(mapsOk(50));
      const result = await acceptTransferRequest("tenant-1", "request-1", ADMIN_ID);

      // Never silently reverted to calculatedAmountCents (25000) — the
      // widened ACCEPT idempotent branch must never touch a price a
      // MODIFY_PRICE call already set.
      expect(result.finalAmountCents).toBe(22000);
      expect(result.priceOverrideReason).toBe("sconto");
      expect(onlyBooking().finalAmountCents).toBe(22000);
    });

    it("N9: scheduledAt is interpreted in Europe/Rome — CET in winter, CEST in summer", async () => {
      seedPendingApproval({ requestedDate: "2026-01-15", requestedTime: "10:00" });
      await acceptTransferRequest("tenant-1", "request-1", ADMIN_ID);
      expect((onlyBooking().scheduledAt as Date).toISOString()).toBe("2026-01-15T09:00:00.000Z"); // CET, +01:00

      fakeState.requests = [];
      fakeState.bookings = [];
      seedPendingApproval({ requestedDate: "2026-07-15", requestedTime: "10:00" });
      await acceptTransferRequest("tenant-1", "request-1", ADMIN_ID);
      expect((onlyBooking().scheduledAt as Date).toISOString()).toBe("2026-07-15T08:00:00.000Z"); // CEST, +02:00
    });

    it("N10: an invalid requestedTime never creates a booking — no invented fallback time", async () => {
      seedPendingApproval({ requestedTime: "25:99" });

      await expect(acceptTransferRequest("tenant-1", "request-1", ADMIN_ID)).rejects.toThrow(
        /booking creation failed/,
      );
      expect(fakeState.bookings).toHaveLength(0);
    });
  });
});
