export {
  handleCustomerMessageOutcome,
  handleFounderMessage,
  approveQuoteRound,
  rejectQuoteRound,
  reviseQuoteRound,
  listPendingForPanel,
  getRoundForPanel,
} from "./service";
export type {
  CustomerMessageOutcome,
  FounderInboundMessage,
  DecisionResult,
  DecisionOutcome,
  PanelPending,
  PanelRound,
  PanelRoundDetail,
  PanelManualPrice,
  RoundView,
} from "./service";
export { quoteApprovalRouter } from "./router";
export { isFounderPhone } from "./founder-channel";
export { isQuoteApprovalEnabled, isCustomerPhoneAllowed, getAdminBaseUrl } from "./config";
export type { QuoteApprovalRequest, FounderWhatsappMessage } from "@bos/db";

// Boundary rule (ADR 0002): other modules/apps import only from here.
