export { calculateRoute, calculateGenericRouteRoundTrip, calculateComoTiranoRoundTrip } from "./service";
export * from "./schema";

// Boundary rule (ADR 0002): other modules/apps import only from here.
// This module computes distance/duration only — it never decides a price,
// a customer type, a minimum fare, a surcharge, calendar availability, or
// admin approval. Those decisions stay entirely inside packages/core/src/pricing
// and packages/core/src/transfer-requests; this module is never imported by
// pricing/service.ts, only by the transfer-requests connection that already
// knows when a distance is actually needed.
