export {
  prepareQuoteOfferCommunication,
  submitCommunicationForApproval,
  approveCommunication,
  rejectCommunication,
  executeCommunication,
  getCommunication,
  findCommunicationByIdempotencyKey,
  findCommunicationByProviderMessageId,
  recordProviderDeliveryStatus,
  listCommunicationsForDeal,
  sendMissingInfoRequest,
  hasCommunicationForTransferRequest,
  prepareTransferQuoteOfferCommunication,
} from "./service";
export type { SendMissingInfoRequestInput, PrepareTransferQuoteOfferInput } from "./service";
export * from "./schema";
export type { OutboundProvider, OutboundMessageRequest, OutboundSendResult } from "./provider";
export { NotConfiguredOutboundProvider, getConfiguredOutboundProvider } from "./provider";
export { WhatsAppCloudApiProvider, isE164, type WhatsAppTemplateConfig } from "./whatsapp-cloud-api-provider";
export {
  buildQuoteOfferContent,
  buildMissingInfoRequestContent,
  buildTransferQuoteOfferContent,
  toCustomerLanguage,
  formatAmountForCustomer,
  formatDateForCustomer,
} from "./content";
export type { CustomerLanguage, MissingInfoRequestInput, TransferQuoteOfferInput } from "./content";
export {
  postWhatsappCloudApiMessage,
  getWhatsappCloudApiCredentials,
  type WhatsappCloudApiCredentials,
} from "./whatsapp-cloud-api-client";
export type { Communication, NewCommunication } from "@bos/db";

// Boundary rule (ADR 0002): other modules import only from here.
