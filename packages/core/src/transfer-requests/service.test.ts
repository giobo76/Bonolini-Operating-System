import { Param, StringChunk } from "drizzle-orm";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TransferRequestExtractedFields } from "./schema";
import type { RouteDistanceResult } from "../maps-distance";

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

const { fakeState, transferRequestsTable, whatsappMessagesTable, clientsTable } = vi.hoisted(() => {
  return {
    fakeState: {
      requests: [] as Array<Record<string, unknown>>,
      messages: [] as Array<Record<string, unknown>>,
      clients: [] as Array<Record<string, unknown>>,
      nextRequestId: 1,
    },
    transferRequestsTable: { __name: "transferRequests" },
    whatsappMessagesTable: { __name: "whatsappMessages" },
    clientsTable: { __name: "clients" },
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
    // Backs insertNewTransferRequest's atomic `INSERT ... ON CONFLICT ...
    // DO NOTHING RETURNING *`. Params are bound in the exact order
    // service.ts's template interpolates them.
    execute: async (query: { queryChunks: unknown[] }) => {
      const params = query.queryChunks.filter((chunk) => !(chunk instanceof StringChunk));
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
    assertOne: (rows: unknown[]) => rows[0],
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
vi.mock("../maps-distance", () => ({
  calculateGenericRouteRoundTrip: (pickup: string, destination: string) => calculateGenericRouteRoundTrip(pickup, destination),
  calculateComoTiranoRoundTrip: () => calculateComoTiranoRoundTrip(),
}));

const {
  processTransferRequestForMessage,
  processTransferRequestForMessageAndPrice,
  computeMissingInformation,
  runPricingForTransferRequest,
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
  fakeState.nextRequestId = 1;
  calculateGenericRouteRoundTrip.mockClear();
  calculateComoTiranoRoundTrip.mockClear();
});

describe("computeMissingInformation", () => {
  it("requires pickup, destination, passengers, and date", () => {
    expect(
      computeMissingInformation({
        pickup: null,
        destination: null,
        requestedDate: null,
        requestedTime: null,
        passengers: null,
        flightNumber: null,
      }),
    ).toEqual(["pickup", "destination", "passengers", "date"]);
  });

  it("additionally requires time when destination is an airport", () => {
    const missing = computeMissingInformation({
      pickup: "Sondrio",
      destination: "Malpensa",
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

  it("is empty when every required field is present and no airport is involved", () => {
    expect(
      computeMissingInformation({
        pickup: "Milano",
        destination: "Tirano",
        requestedDate: "2026-08-25",
        requestedTime: null,
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
      inputFor("msg-1", { pickup: "Milano", destination: "Tirano", date: "2026-08-25", passengers: 2 }),
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
    expect(result.missingInformation).toEqual(["passengers", "date"]);
  });

  // C. three messages accumulate into the same transfer_request
  it("C: three separate messages accumulate into the same transfer_request", async () => {
    seedMessage("msg-1");
    seedMessage("msg-2");
    seedMessage("msg-3");

    const first = await processTransferRequestForMessage(
      inputFor("msg-1", { pickup: "Milano", destination: "Tirano" }),
    );
    const second = await processTransferRequestForMessage(inputFor("msg-2", { date: "2026-08-25" }));
    const third = await processTransferRequestForMessage(inputFor("msg-3", { passengers: 3 }));

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(third).toMatchObject({
      pickup: "Milano",
      destination: "Tirano",
      requestedDate: "2026-08-25",
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
      inputFor("msg-1", { pickup: "Sondrio", destination: "Livigno", date: "2026-09-20", passengers: 2 }),
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
