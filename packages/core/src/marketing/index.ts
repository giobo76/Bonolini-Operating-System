export { marketingRouter } from "./router";
export * from "./schema";
export {
  upsertConnection,
  createFinding,
  recordHealthScoreSnapshot,
  listReports,
  getReport,
  confirmLeadByContactToken,
  recordAmbiguousLeadCandidates,
  listLeadMatchCandidates,
} from "./service";
export type { ConfirmLeadByContactTokenResult, RecordAmbiguousLeadCandidatesResult } from "./service";
export { generateContactToken, extractContactToken } from "./contact-token";
export { findTimeProximityCandidates } from "./lead-matching";
export type { CandidateLeadInput, CandidateMessageInput, CandidatePair } from "./lead-matching";
export { runCheck } from "./run-check";
export { assertValidOAuthRedirectUri, getCalendarClient } from "./google-clients";
export { trackLeadConversion, sendGa4ConversionEvent, resolveGa4ClientId } from "./measurement-protocol";
export type { Ga4ConversionEventInput, Ga4ConversionEventResult } from "./measurement-protocol";
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
  getLeadConversionBySource,
  getRealConversionSummary,
  getTransferRequestFunnel,
} from "./business-kpis";
export type {
  FunnelSummary,
  FunnelSourceSummary,
  ConversionRates,
  RevenueSourceEntry,
  LtvSourceEntry,
  CostPerStageEntry,
  LeadConversionBySource,
  LeadConversionSourceEntry,
  RealConversionSummary,
  TransferRequestFunnel,
} from "./business-kpis";
export type {
  MarketingConnection,
  MarketingLinkedResource,
  CheckRun,
  Finding,
  MarketingHealthScore,
  Report,
  MarketingLead,
  LeadMatchCandidate,
} from "@bos/db";

// upsertConnection is exported directly (not only via the router) because
// the OAuth callback route handler needs to call it outside of a normal
// tRPC request — same documented exception as webhooks in
// docs/domain/13-api-contracts.md.
