# maps-distance — distance/duration only, never pricing

**Status:** Core v1 — a single provider (Google Routes API), no caching, no retries beyond what `fetch` itself does.

**Owns:** nothing persistent — this module has no database access at all. Every export is a pure async wrapper around one HTTP call; same input always produces the same real-world Google Maps answer (or a structured error), no side effects of its own.

**Exposes:** `calculateRoute`, `calculateGenericRouteRoundTrip`, `calculateComoTiranoRoundTrip`, and every type in `schema.ts`.

**Emits / Listens to:** — (pure module, not wired into any event flow).

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this and every other domain module follows.

## What this module does NOT do

Deliberately, by design — enforced by keeping this module's only consumer (`transfer-requests`) responsible for all of the following, never this one:

- Does not decide a price, a rate per km, a minimum fare, or a toll estimate (`packages/core/src/pricing` owns all of that).
- Does not decide whether a customer is italian/foreign.
- Does not decide whether a route even needs a distance calculated — the caller (`transfer-requests/service.ts::runPricingForTransferRequest`) only calls this module after `calculatePrice()` itself has already said, by returning `manualRequiredReason: "distance_not_provided"`, that a distance is the only thing missing.
- Does not check calendar availability or admin approval.

## Source of truth

Recovered from `CChiefGrowthAI/ai/booking_bot/maps_distance.py`, ported as a concept (waypoints in, structured distance/duration out), not as a line-by-line translation — the old file called the legacy Distance Matrix API once per leg and buried the result as free-text inside `pricing_engine.py`'s `note` string; this module calls the newer Routes API (`routes.googleapis.com/directions/v2:computeRoutes`) once per request (using `intermediates` to resolve every leg of a multi-stop itinerary in a single call) and returns every leg as structured data.

| Old function | New export | Difference |
|---|---|---|
| `km_andata_ritorno_da_sondrio(destinazione)` | `calculateGenericRouteRoundTrip(pickup, destination)` | Old code hardcoded origin `"Sondrio"` and doubled a single Sondrio→destination leg, silently assuming pickup was always Sondrio. New code sums two real legs (`pickup→destination`, `destination→"Sondrio"`) — identical number when pickup genuinely is Sondrio, more correct otherwise. |
| `km_percorso_como_tirano()` | `calculateComoTiranoRoundTrip()` | Same fixed itinerary (`Sondrio→Como→Tirano→Sondrio`), same 3 legs, now resolved in one HTTP call instead of three. |
| `_dettagli_percorso(a, b)` | `calculateRoute(waypoints)` | Generalized from a single pair to an arbitrary ordered list of waypoints — the primitive both convenience wrappers above are built on, and what a future caller with its own waypoint convention (case C: `pickup → destination`, no fixed return leg) can call directly. |

`km`/`minuti` rounding convention preserved exactly: km to 1 decimal, duration to the nearest whole minute.

## Error handling — never invents a number

Every failure mode resolves to `{ status: "error", error: { code, message } }`, `distanceKm`/`durationMinutes`/`legs` all empty/null — never a guessed or fallback distance:

- `api_key_missing` — `GOOGLE_MAPS_API_KEY` not set (mirrors the old code's own `if not API_KEY` fail-soft branch).
- `invalid_input` — fewer than 2 waypoints, or an empty/whitespace-only waypoint.
- `request_failed` — network error, non-2xx HTTP response, or a response body that isn't valid JSON.
- `no_route_found` — the API responded successfully but returned no route, or fewer/malformed legs than the waypoint list requires.

## Env

`GOOGLE_MAPS_API_KEY` — same variable name already reserved in `.env.example` since Phase 0 planning, now actually used. Requires the **Routes API** enabled on the Google Cloud project the key belongs to (not the legacy Distance Matrix API the old bot used — different product on Google's side, same kind of API key).

## Not implemented

- No caching of repeated pickup/destination pairs.
- No traffic-aware routing (`routingPreference` left at Google's default) — CChiefGrowthAI never used traffic data either.
- No multi-provider fallback (e.g. OpenRouteService) — `ai/operations/routing_service.py`'s docstring mentioned this as a future idea in the old project; it was never implemented there either (confirmed during the CChiefGrowthAI audit — that file is a permanent stub returning zeros).
