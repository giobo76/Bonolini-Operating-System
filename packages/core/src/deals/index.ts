export {
  createDeal,
  getDeal,
  getActiveDealsForClient,
  findMatchingDealForMessage,
  reopenRecentClosedDealIfMatching,
  closeDeal,
  advanceDealStatus,
  touchDealLastMessageAt,
  looksLikeCustomerReportedPayment,
  recordCustomerReportedPayment,
  type DealMatchResult,
} from "./service";
export * from "./schema";
export type { Deal, NewDeal } from "@bos/db";

// Boundary rule (ADR 0002): other modules import only from here.
// getMostRecentTransferRequestForDeal, scoreCandidate, disambiguateActiveDeals
// (service.ts) are deliberately not exported — findMatchingDealForMessage
// is the only entry point that decides which deal a message belongs to.
