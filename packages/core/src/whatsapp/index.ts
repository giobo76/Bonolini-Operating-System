export {
  handleWhatsappVerification,
  handleWhatsappWebhookRequest,
  verifyMetaSignature,
} from "./webhook-handler";
export type {
  WhatsappVerificationResult,
  WhatsappWebhookRequestInput,
  WhatsappWebhookResult,
} from "./webhook-handler";
export { processInboundMessage, normalizePhone } from "./service";
export type { ProcessInboundMessageResult } from "./service";
export { parseWhatsappMessage } from "./parser";
export * from "./schema";
export type { WhatsappMessage, NewWhatsappMessage } from "@bos/db";

// Boundary rule (ADR 0002): other modules/apps import only from here — the
// route handler imports handleWhatsappVerification/handleWhatsappWebhookRequest,
// nothing else reaches into webhook-handler.ts/service.ts/parser.ts directly.
