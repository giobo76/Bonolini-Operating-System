import { z } from "zod";

// One computed leg between two consecutive waypoints — the structured
// equivalent of what CChiefGrowthAI's _dettagli_percorso returned per call,
// except here every leg comes back from a single Routes API request
// (computeRoutes' `intermediates`), never one HTTP call per leg.
export interface RouteLeg {
  origin: string;
  destination: string;
  distanceKm: number;
  durationMinutes: number;
}

export const routeDistanceStatusSchema = z.enum(["ok", "error"]);
export type RouteDistanceStatus = z.infer<typeof routeDistanceStatusSchema>;

// Every failure mode CChiefGrowthAI's maps_distance.py could silently
// return None for, made explicit instead — never a guessed distance, but
// never a bare "something went wrong" either.
export const routeDistanceErrorCodeSchema = z.enum([
  "api_key_missing",
  "invalid_input",
  "request_failed",
  "no_route_found",
]);
export type RouteDistanceErrorCode = z.infer<typeof routeDistanceErrorCodeSchema>;

export interface RouteDistanceError {
  code: RouteDistanceErrorCode;
  // Safe to log/persist as-is — never includes the API key or raw request
  // body.
  message: string;
}

export interface RouteDistanceResult {
  status: RouteDistanceStatus;
  provider: "google_routes_api";
  // Totals across every leg, rounded once here (km to 1 decimal, minutes
  // to the nearest whole minute — same rounding convention as
  // CChiefGrowthAI's km_andata_ritorno_da_sondrio/km_percorso_como_tirano).
  // null when status is "error".
  distanceKm: number | null;
  durationMinutes: number | null;
  // One entry per consecutive waypoint pair, in order. Empty on error.
  legs: RouteLeg[];
  error: RouteDistanceError | null;
}
