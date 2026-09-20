export {
  prepareQuoteOfferCommunication,
  submitCommunicationForApproval,
  approveCommunication,
  rejectCommunication,
  executeCommunication,
  getCommunication,
  findCommunicationByIdempotencyKey,
  listCommunicationsForDeal,
} from "./service";
export * from "./schema";
export type { OutboundProvider, OutboundMessageRequest, OutboundSendResult } from "./provider";
export { NotConfiguredOutboundProvider, getConfiguredOutboundProvider } from "./provider";
export { buildQuoteOfferContent } from "./content";
export type { Communication, NewCommunication } from "@bos/db";

// Boundary rule (ADR 0002): other modules import only from here.
