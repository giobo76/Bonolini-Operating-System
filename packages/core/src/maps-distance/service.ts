import type { RouteDistanceResult, RouteDistanceErrorCode, RouteLeg } from "./schema";

const COMPUTE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const FIELD_MASK = "routes.legs.distanceMeters,routes.legs.duration";

// CChiefGrowthAI always appended ", Italia" to every address before calling
// Google (maps_distance.py's _dettagli_percorso) — the business only
// operates in Italy, and this avoids an ambiguous match for a short place
// name (e.g. "Como" resolving outside Italy). Same convention here.
function withRegionHint(place: string): string {
  return `${place}, Italia`;
}

function errorResult(code: RouteDistanceErrorCode, message: string): RouteDistanceResult {
  return { status: "error", provider: "google_routes_api", distanceKm: null, durationMinutes: null, legs: [], error: { code, message } };
}

// Routes API encodes duration as a protobuf Duration string, e.g. "1234s" —
// never a bare number.
function parseDurationSeconds(duration: unknown): number | null {
  if (typeof duration !== "string" || !duration.endsWith("s")) return null;
  const seconds = Number.parseFloat(duration.slice(0, -1));
  return Number.isFinite(seconds) ? seconds : null;
}

interface ComputeRoutesLeg {
  distanceMeters?: number;
  duration?: string;
}

interface ComputeRoutesResponse {
  routes?: Array<{ legs?: ComputeRoutesLeg[] }>;
}

// The single HTTP call every export below funnels through. `waypoints`
// must have at least 2 entries; consecutive pairs become legs (the first
// entry is `origin`, the last is `destination`, anything in between is
// passed as `intermediates`) — resolved in ONE computeRoutes request, never
// one HTTP call per leg the way CChiefGrowthAI's per-leg _dettagli_percorso
// calls worked.
//
// Never throws: every failure (missing key, network error, non-OK
// response, no usable route) resolves to a structured `status: "error"`
// result instead, per the same "never guess, never invent" discipline the
// pricing engine already follows.
export async function calculateRoute(waypoints: string[]): Promise<RouteDistanceResult> {
  if (waypoints.length < 2 || waypoints.some((waypoint) => !waypoint.trim())) {
    return errorResult(
      "invalid_input",
      `calculateRoute requires at least 2 non-empty waypoints, got: ${JSON.stringify(waypoints)}`,
    );
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return errorResult("api_key_missing", "GOOGLE_MAPS_API_KEY is not configured.");
  }

  const origin = waypoints[0]!;
  const rest = waypoints.slice(1);
  const destination = rest[rest.length - 1]!;
  const intermediates = rest.slice(0, -1);

  const requestBody = {
    origin: { address: withRegionHint(origin) },
    destination: { address: withRegionHint(destination) },
    intermediates: intermediates.map((place) => ({ address: withRegionHint(place) })),
    travelMode: "DRIVE",
    languageCode: "it",
    regionCode: "IT",
  };

  let response: Response;
  try {
    response = await fetch(COMPUTE_ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    return errorResult("request_failed", error instanceof Error ? error.message : "Network error calling Google Routes API.");
  }

  if (!response.ok) {
    return errorResult("request_failed", `Google Routes API returned HTTP ${response.status}.`);
  }

  let data: ComputeRoutesResponse;
  try {
    data = (await response.json()) as ComputeRoutesResponse;
  } catch {
    return errorResult("request_failed", "Google Routes API returned a non-JSON response.");
  }

  const routeLegs = data.routes?.[0]?.legs;
  if (!routeLegs || routeLegs.length !== waypoints.length - 1) {
    return errorResult("no_route_found", `Google Routes API found no usable route for: ${waypoints.join(" -> ")}.`);
  }

  const legs: RouteLeg[] = [];
  let totalMeters = 0;
  let totalSeconds = 0;

  for (let i = 0; i < routeLegs.length; i++) {
    const leg = routeLegs[i]!;
    const seconds = parseDurationSeconds(leg.duration);
    if (typeof leg.distanceMeters !== "number" || seconds === null) {
      return errorResult("no_route_found", `Google Routes API returned an incomplete leg for ${waypoints[i]} -> ${waypoints[i + 1]}.`);
    }
    totalMeters += leg.distanceMeters;
    totalSeconds += seconds;
    legs.push({
      origin: waypoints[i]!,
      destination: waypoints[i + 1]!,
      // Same rounding convention as CChiefGrowthAI's maps_distance.py:
      // km to 1 decimal, duration to the nearest whole minute.
      distanceKm: Math.round((leg.distanceMeters / 1000) * 10) / 10,
      durationMinutes: Math.round(seconds / 60),
    });
  }

  return {
    status: "ok",
    provider: "google_routes_api",
    distanceKm: Math.round((totalMeters / 1000) * 10) / 10,
    durationMinutes: Math.round(totalSeconds / 60),
    legs,
    error: null,
  };
}

// Case A — the approved commercial convention for a generic (non-fixed,
// non-Como-Tirano) trip: pickup -> destination -> back to Sondrio (the
// base) empty. CChiefGrowthAI's own km_andata_ritorno_da_sondrio only ever
// computed Sondrio -> destination and doubled it, silently assuming pickup
// was always Sondrio — true for how the business operates today, but not
// something this module should hardcode as "pickup is irrelevant". Passing
// the real pickup and summing two real legs produces the identical number
// when pickup genuinely is Sondrio, and the more correct one on the rare
// case it isn't.
export async function calculateGenericRouteRoundTrip(pickup: string, destination: string): Promise<RouteDistanceResult> {
  return calculateRoute([pickup, destination, "Sondrio"]);
}

// Case B — the fixed, named Como-Tirano (Bernina Express) itinerary:
// Sondrio -> Como -> Tirano -> Sondrio, verbatim from CChiefGrowthAI's
// km_percorso_como_tirano. Never parameterized by pickup/destination — this
// is always the same physical route regardless of what the customer typed,
// exactly like the original.
export async function calculateComoTiranoRoundTrip(): Promise<RouteDistanceResult> {
  return calculateRoute(["Sondrio", "Como", "Tirano", "Sondrio"]);
}
