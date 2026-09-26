export {
  determineRelocationOrigin,
  calculateServiceEndAt,
  calculateVehicleReadyAt,
  isServiceFeasible,
  estimateVehicleFreeAt,
} from "./service";
export * from "./schema";
export {
  FALLBACK_BUSY_MINUTES,
  MINIMUM_EVENT_DURATION_RULE_KEY,
  minimumEventDurationRuleContentSchema,
  computeBusyWindow,
  findRouteMinimum,
  windowsOverlap,
  findOverlaps,
  type MinimumEventDurationRuleContent,
  type AppliedMinimum,
  type BusyWindowInput,
  type BusyWindow,
  type TimeWindow,
} from "./busy-window";
export {
  computeServiceBusyWindow,
  resolveMinimumRule,
  toStoredBusyWindow,
  fromStoredBusyWindow,
  storedBusyWindowSchema,
  type ServiceBusyWindow,
  type StoredBusyWindow,
} from "./service-window";

// Boundary rule (ADR 0002): other modules/apps import only from here.
// service.ts and busy-window.ts are pure; service-window.ts calls Google
// Maps and the Business Rules for the busy window (README.md, "Busy window
// and overlap check").
