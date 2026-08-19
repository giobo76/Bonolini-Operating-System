import { z } from "zod";

export const transferRequestStatusSchema = z.enum([
  "collecting_info",
  "ready_for_pricing",
  "pending_admin_approval",
  "approved",
  "converted_to_quote",
  "cancelled",
  "expired",
]);

export const transferRequestPricingStatusSchema = z.enum([
  "not_priced",
  "fixed",
  "calculated_km",
  "manual_required",
]);

// The subset of a WhatsApp-parsed message relevant to a transfer request.
// Deliberately its own shape, not a re-export of the whatsapp module's
// ParsedWhatsappMessage — keeps this module decoupled from the whatsapp
// module's parser internals per ADR 0002 (cross-module access only through
// each module's index.ts, and only for what's actually needed here).
// Mapping ParsedWhatsappMessage -> this shape is the caller's job, not
// this module's.
export const transferRequestExtractedFieldsSchema = z.object({
  intent: z.string().trim().min(1).optional(),
  pickup: z.string().trim().min(1).optional(),
  destination: z.string().trim().min(1).optional(),
  date: z.string().trim().min(1).optional(),
  time: z.string().trim().min(1).optional(),
  passengers: z.number().int().positive().optional(),
  luggage: z.string().trim().min(1).optional(),
  flight: z.string().trim().min(1).optional(),
  train: z.string().trim().min(1).optional(),
  hotel: z.string().trim().min(1).optional(),
  language: z.string().trim().min(1).optional(),
});

export type TransferRequestExtractedFields = z.infer<typeof transferRequestExtractedFieldsSchema>;
