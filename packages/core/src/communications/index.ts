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
  sendBookingConfirmation,
  prepareTransferQuoteOfferCommunication,
} from "./service";
export type {
  SendMissingInfoRequestInput,
  SendBookingConfirmationInput,
  PrepareTransferQuoteOfferInput,
} from "./service";
export * from "./schema";
export type { OutboundProvider, OutboundMessageRequest, OutboundSendResult } from "./provider";
export { NotConfiguredOutboundProvider, getConfiguredOutboundProvider } from "./provider";
export { WhatsAppCloudApiProvider, isE164, type WhatsAppTemplateConfig } from "./whatsapp-cloud-api-provider";
export {
  buildQuoteOfferContent,
  buildMissingInfoRequestContent,
  buildTransferQuoteOfferContent,
  buildBookingConfirmationContent,
  toCustomerLanguage,
  formatAmountForCustomer,
  formatDateForCustomer,
  formatLongDateTime,
  formatPassengers,
  capitalizePlace,
} from "./content";
export type {
  CustomerLanguage,
  MissingInfoRequestInput,
  TransferQuoteOfferInput,
  BookingConfirmationInput,
} from "./content";
export {
  postWhatsappCloudApiMessage,
  getWhatsappCloudApiCredentials,
  type WhatsappCloudApiCredentials,
} from "./whatsapp-cloud-api-client";
export type { Communication, NewCommunication } from "@bos/db";

// Boundary rule (ADR 0002): other modules import only from here.
