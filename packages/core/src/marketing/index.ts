export { marketingRouter } from "./router";
export * from "./schema";
export {
  upsertConnection,
  createFinding,
  recordHealthScoreSnapshot,
  listReports,
  getReport,
} from "./service";
export { runCheck } from "./run-check";
export type { CheckRunType } from "./run-check";
export {
  handleLeadIntentRequest,
  handleLeadIntentPreflight,
  ALLOWED_ORIGIN as leadIntentAllowedOrigin,
} from "./lead-intent-handler";
export type { LeadIntentRequestInput, LeadIntentResult } from "./lead-intent-handler";
export { runWeeklyReport } from "./weekly-report";
export { marketingInngestFunctions } from "./inngest-functions";
export { computeHealthScore } from "./health-score";
export type { HealthScoreBreakdown, HealthScoreResult, OpportunityValueItem } from "./health-score";
export {
  getFunnelSummary,
  getConversionRates,
  getRevenueBySource,
  getLtvBySource,
  getCostPerStageBySource,
} from "./business-kpis";
export type {
  FunnelSummary,
  FunnelSourceSummary,
  ConversionRates,
  RevenueSourceEntry,
  LtvSourceEntry,
  CostPerStageEntry,
} from "./business-kpis";
export type {
  MarketingConnection,
  MarketingLinkedResource,
  CheckRun,
  Finding,
  MarketingHealthScore,
  Report,
} from "@bos/db";

// upsertConnection is exported directly (not only via the router) because
// the OAuth callback route handler needs to call it outside of a normal
// tRPC request — same documented exception as webhooks in
// docs/domain/13-api-contracts.md.
