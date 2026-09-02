export {
  determineRelocationOrigin,
  calculateServiceEndAt,
  calculateVehicleReadyAt,
  isServiceFeasible,
  estimateVehicleFreeAt,
} from "./service";
export * from "./schema";

// Boundary rule (ADR 0002): other modules/apps import only from here.
// Pure module, no database access, no Google Maps/Calendar calls — see
// service.ts's own header comment and README.md for what this deliberately
// does not do yet.
