export { calculatePrice, determineCustomerType } from "./service";
export * from "./schema";

// Boundary rule (ADR 0002): other modules/apps import only from here — the
// keyword tables, fare tables, and internal builders in service.ts are
// deliberately not exported; calculatePrice/determineCustomerType are the
// only two entry points.
