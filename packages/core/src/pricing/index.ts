export { calculatePrice, determineCustomerType, isComoTiranoRoute } from "./service";
export * from "./schema";

// Boundary rule (ADR 0002): other modules/apps import only from here — the
// keyword tables, fare tables, and internal builders in service.ts are
// deliberately not exported. isComoTiranoRoute is the one deliberate
// exception beyond calculatePrice/determineCustomerType: it's a pure route
// classification fact (not a pricing decision), exported specifically so
// transfer-requests can pick the right maps-distance waypoint convention
// without duplicating this keyword check — see maps-distance/README.md.
