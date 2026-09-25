import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  calculateRoute,
  calculateGenericRouteRoundTrip,
  calculateComoTiranoRoundTrip,
  calculateBusyLoopFromBase,
} from "./service";

// global fetch is mocked for every test in this file — no real network call
// to Google is ever made. `fetchMock` intercepts every request/response
// pair so each test can assert exactly what was sent and control exactly
// what comes back.
const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.GOOGLE_MAPS_API_KEY = "test-key-do-not-use";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_MAPS_API_KEY;
});

function computeRoutesResponse(legs: Array<{ km: number; minutes: number }>) {
  return {
    routes: [
      {
        legs: legs.map((leg) => ({
          distanceMeters: Math.round(leg.km * 1000),
          duration: `${leg.minutes * 60}s`,
        })),
      },
    ],
  };
}

describe("calculateRoute", () => {
  it("1: a generic two-point route returns one leg with correctly converted km/minutes", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(computeRoutesResponse([{ km: 42.3, minutes: 55 }])));

    const result = await calculateRoute(["Sondrio", "Livigno"]);

    expect(result.status).toBe("ok");
    expect(result.provider).toBe("google_routes_api");
    expect(result.distanceKm).toBe(42.3);
    expect(result.durationMinutes).toBe(55);
    expect(result.legs).toEqual([{ origin: "Sondrio", destination: "Livigno", distanceKm: 42.3, durationMinutes: 55 }]);
    expect(result.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends origin/destination/intermediates split correctly and never a real network call (mocked)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(computeRoutesResponse([{ km: 10, minutes: 15 }, { km: 20, minutes: 25 }, { km: 5, minutes: 8 }])),
    );

    await calculateRoute(["Sondrio", "Como", "Tirano", "Sondrio"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://routes.googleapis.com/directions/v2:computeRoutes");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Goog-Api-Key"]).toBe("test-key-do-not-use");
    const body = JSON.parse(init.body);
    expect(body.origin).toEqual({ address: "Sondrio, Italia" });
    expect(body.destination).toEqual({ address: "Sondrio, Italia" });
    expect(body.intermediates).toEqual([{ address: "Como, Italia" }, { address: "Tirano, Italia" }]);
  });

  it("2: Como-Tirano (3 legs) sums correctly via calculateComoTiranoRoundTrip", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        computeRoutesResponse([
          { km: 30, minutes: 40 },
          { km: 25.5, minutes: 35 },
          { km: 30, minutes: 40 },
        ]),
      ),
    );

    const result = await calculateComoTiranoRoundTrip();

    expect(result.status).toBe("ok");
    expect(result.distanceKm).toBe(85.5);
    expect(result.durationMinutes).toBe(115);
    expect(result.legs).toHaveLength(3);
    expect(result.legs.map((leg) => `${leg.origin}->${leg.destination}`)).toEqual([
      "Sondrio->Como",
      "Como->Tirano",
      "Tirano->Sondrio",
    ]);
  });

  it("2b: calculateGenericRouteRoundTrip sums pickup->destination->Sondrio (2 legs)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(computeRoutesResponse([{ km: 60, minutes: 70 }, { km: 60, minutes: 70 }])));

    const result = await calculateGenericRouteRoundTrip("Sondrio", "Livigno");

    expect(result.status).toBe("ok");
    expect(result.distanceKm).toBe(120);
    expect(result.durationMinutes).toBe(140);
    expect(result.legs.map((leg) => `${leg.origin}->${leg.destination}`)).toEqual(["Sondrio->Livigno", "Livigno->Sondrio"]);
  });

  it("3: a non-OK HTTP response resolves to a structured request_failed error, not a thrown exception", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Internal error", { status: 500 }));

    const result = await calculateRoute(["Sondrio", "Livigno"]);

    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ code: "request_failed" });
    expect(result.distanceKm).toBeNull();
    expect(result.durationMinutes).toBeNull();
    expect(result.legs).toEqual([]);
  });

  it("3b: a network-level fetch rejection resolves to a structured request_failed error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const result = await calculateRoute(["Sondrio", "Livigno"]);

    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ code: "request_failed", message: "network down" });
  });

  it("4: a 200 response with no routes resolves to no_route_found", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ routes: [] }));

    const result = await calculateRoute(["Sondrio", "Nowhereland"]);

    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ code: "no_route_found" });
  });

  it("4b: a response with a mismatched leg count resolves to no_route_found, not a wrong total", async () => {
    // 3 waypoints requested (2 legs expected) but Google only returns 1 leg.
    fetchMock.mockResolvedValueOnce(jsonResponse(computeRoutesResponse([{ km: 10, minutes: 10 }])));

    const result = await calculateRoute(["Sondrio", "Como", "Tirano"]);

    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ code: "no_route_found" });
  });

  it("api_key_missing when GOOGLE_MAPS_API_KEY is unset — never calls fetch", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const result = await calculateRoute(["Sondrio", "Livigno"]);

    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ code: "api_key_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invalid_input for fewer than 2 waypoints — never calls fetch", async () => {
    const result = await calculateRoute(["Sondrio"]);

    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ code: "invalid_input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invalid_input for a blank waypoint — never calls fetch", async () => {
    const result = await calculateRoute(["Sondrio", "   "]);

    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({ code: "invalid_input" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("5: km rounds to 1 decimal and duration rounds to the nearest whole minute", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ routes: [{ legs: [{ distanceMeters: 12345, duration: "925s" }] }] }),
    );

    const result = await calculateRoute(["Sondrio", "Livigno"]);

    // 12345m -> 12.345km -> rounded to 1 decimal -> 12.3
    expect(result.distanceKm).toBe(12.3);
    // 925s -> 15.41... min -> rounded -> 15
    expect(result.durationMinutes).toBe(15);
  });

  it("6: never issues a real network call — fetch is always the mocked stub in this suite", () => {
    expect(fetch).toBe(fetchMock);
  });
});

// Production, 2026-09-25: Malpensa -> Sondrio asked Google for a
// zero-length Sondrio -> Sondrio leg and failed ("incomplete leg").
describe("calculateGenericRouteRoundTrip — base Sondrio as pickup or destination", () => {
  it("destination Sondrio: Sondrio -> pickup -> Sondrio, never a Sondrio -> Sondrio leg", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(computeRoutesResponse([{ km: 150, minutes: 130 }, { km: 150, minutes: 130 }])));

    const result = await calculateGenericRouteRoundTrip("Malpensa", "Sondrio");

    expect(result.status).toBe("ok");
    expect(result.distanceKm).toBe(300);
    expect(result.legs.map((leg) => `${leg.origin}->${leg.destination}`)).toEqual(["Sondrio->Malpensa", "Malpensa->Sondrio"]);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.origin.address).toBe("Sondrio, Italia");
    expect(body.intermediates).toEqual([{ address: "Malpensa, Italia" }]);
    expect(body.destination.address).toBe("Sondrio, Italia");
  });

  it("X -> Sondrio costs the same distance as Sondrio -> X (same two legs)", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(computeRoutesResponse([{ km: 150, minutes: 130 }, { km: 150, minutes: 130 }])),
    );

    const outbound = await calculateGenericRouteRoundTrip("Sondrio", "Malpensa");
    const inbound = await calculateGenericRouteRoundTrip("Malpensa", "Sondrio centro");

    expect(inbound.distanceKm).toBe(outbound.distanceKm);
  });

  it("pickup Sondrio: unchanged, pickup -> destination -> Sondrio", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(computeRoutesResponse([{ km: 60, minutes: 70 }, { km: 60, minutes: 70 }])));

    const result = await calculateGenericRouteRoundTrip("Sondrio", "Livigno");

    expect(result.legs.map((leg) => `${leg.origin}->${leg.destination}`)).toEqual(["Sondrio->Livigno", "Livigno->Sondrio"]);
  });

  it("neither is Sondrio: unchanged, pickup -> destination -> Sondrio", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(computeRoutesResponse([{ km: 30, minutes: 35 }, { km: 70, minutes: 80 }])),
    );

    const result = await calculateGenericRouteRoundTrip("Morbegno", "Livigno");

    expect(result.legs.map((leg) => `${leg.origin}->${leg.destination}`)).toEqual(["Morbegno->Livigno", "Livigno->Sondrio"]);
  });

  it("destination a full Sondrio address: treated as the base, no Sondrio -> Sondrio leg", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(computeRoutesResponse([{ km: 150, minutes: 130 }, { km: 150, minutes: 130 }])));

    const result = await calculateGenericRouteRoundTrip("Malpensa", "Via Roma 1, 23100 Sondrio");

    expect(result.legs.map((leg) => `${leg.origin}->${leg.destination}`)).toEqual(["Sondrio->Malpensa", "Malpensa->Sondrio"]);
  });

  it("\"Via Sondrio, Milano\" is Milano, not the base", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(computeRoutesResponse([{ km: 5, minutes: 15 }, { km: 140, minutes: 120 }])));

    const result = await calculateGenericRouteRoundTrip("Linate", "Via Sondrio, Milano");

    expect(result.legs.map((leg) => `${leg.origin}->${leg.destination}`)).toEqual([
      "Linate->Via Sondrio, Milano",
      "Via Sondrio, Milano->Sondrio",
    ]);
  });

  it("both Sondrio: invalid input, no call to Google, never a guessed distance", async () => {
    const result = await calculateGenericRouteRoundTrip("Sondrio", "Stazione di Sondrio");

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("invalid_input");
    expect(result.distanceKm).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Founder decision 2026-09-25: the calendar event lasts the whole time the
// founder is busy, Sondrio -> pickup -> destination -> Sondrio.
describe("calculateBusyLoopFromBase", () => {
  const legsOf = (result: { legs: Array<{ origin: string; destination: string }> }) =>
    result.legs.map((leg) => `${leg.origin}->${leg.destination}`);

  it("neither is Sondrio: three legs, the empty one to the pickup comes first", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(computeRoutesResponse([{ km: 30, minutes: 35 }, { km: 70, minutes: 80 }, { km: 90, minutes: 100 }])),
    );

    const result = await calculateBusyLoopFromBase("Morbegno", "Livigno");

    expect(legsOf(result)).toEqual(["Sondrio->Morbegno", "Morbegno->Livigno", "Livigno->Sondrio"]);
    expect(result.durationMinutes).toBe(215);
    expect(result.minutesBeforePickup).toBe(35);
  });

  it("pickup Sondrio: Sondrio -> destination -> Sondrio, nothing before the pickup", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(computeRoutesResponse([{ km: 150, minutes: 130 }, { km: 150, minutes: 130 }])));

    const result = await calculateBusyLoopFromBase("Via Roma 1, Sondrio", "Malpensa");

    expect(legsOf(result)).toEqual(["Via Roma 1, Sondrio->Malpensa", "Malpensa->Sondrio"]);
    expect(result.durationMinutes).toBe(260);
    expect(result.minutesBeforePickup).toBe(0);
  });

  it("destination Sondrio: Sondrio -> pickup -> Sondrio, the empty leg is before the pickup", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(computeRoutesResponse([{ km: 150, minutes: 130 }, { km: 150, minutes: 140 }])));

    const result = await calculateBusyLoopFromBase("Malpensa", "Sondrio");

    expect(legsOf(result)).toEqual(["Sondrio->Malpensa", "Malpensa->Sondrio"]);
    expect(result.durationMinutes).toBe(270);
    expect(result.minutesBeforePickup).toBe(130);
  });

  it("both Sondrio: invalid input, no call to Google", async () => {
    const result = await calculateBusyLoopFromBase("Sondrio", "Stazione di Sondrio");

    expect(result.status).toBe("error");
    expect(result.minutesBeforePickup).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Google error: no duration, never a guess", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "boom" } }, 500));

    const result = await calculateBusyLoopFromBase("Morbegno", "Livigno");

    expect(result.status).toBe("error");
    expect(result.durationMinutes).toBeNull();
    expect(result.minutesBeforePickup).toBeNull();
  });
});
