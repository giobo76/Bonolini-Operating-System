export { handleCustomerMessageOutcome, handleFounderMessage } from "./service";
export type { CustomerMessageOutcome, FounderInboundMessage } from "./service";
export { isFounderPhone } from "./founder-channel";
export { isQuoteApprovalEnabled, isCustomerPhoneAllowed } from "./config";
export type { QuoteApprovalRequest, FounderWhatsappMessage } from "@bos/db";

// Boundary rule (ADR 0002): other modules/apps import only from here.
