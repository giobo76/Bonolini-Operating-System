import { z } from "zod";

export const communicationStatusSchema = z.enum([
  "prepared",
  "pending_approval",
  "approved",
  "executed",
  "verified",
  "execution_failed",
  "rejected",
]);
export type CommunicationStatus = z.infer<typeof communicationStatusSchema>;

// Statuses from which executeCommunication is still a meaningful call —
// anything else (executed/verified/execution_failed) is an idempotent
// no-op (see service.ts), and 'prepared'/'pending_approval'/'rejected'
// throw (never sent without approval).
export const EXECUTABLE_STATUS = "approved" as const;
export const TERMINAL_EXECUTION_STATUSES = ["executed", "verified", "execution_failed"] as const;

// Only WhatsApp exists as a real inbound integration in this repo (see
// packages/core/src/whatsapp) — this is a label on the prepared content,
// never an actual send integration (none exists; see provider.ts). Kept
// as a plain string, not a literal union, so a future channel never needs
// a schema change here — validated at the one real call site instead
// (content.ts).
export const communicationChannelSchema = z.string().trim().min(1);

export const communicationContentSchema = z.object({
  to: z.string().trim().min(1),
  body: z.string().trim().min(1),
  templateName: z.string().trim().min(1),
});
export type CommunicationContent = z.infer<typeof communicationContentSchema>;

export const prepareQuoteOfferCommunicationInputSchema = z.object({
  tenantId: z.string().uuid(),
  dealId: z.string().uuid(),
  clientId: z.string().uuid(),
  quoteId: z.string().uuid(),
  channel: communicationChannelSchema.default("whatsapp"),
  correlationId: z.string().trim().min(1).optional(),
  agent: z.string().trim().min(1).default("operations"),
});
export type PrepareQuoteOfferCommunicationInput = z.infer<typeof prepareQuoteOfferCommunicationInputSchema>;
