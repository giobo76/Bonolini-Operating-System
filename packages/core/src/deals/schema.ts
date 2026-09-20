import { z } from "zod";

export const dealStatusSchema = z.enum(["open", "quoted", "confirmed", "completed", "cancelled"]);
export type DealStatus = z.infer<typeof dealStatusSchema>;

// Statuses considered "active" for message matching (findMatchingDealForMessage's
// primary lookup, getActiveDealsForClient). Founder-approved rule: "quoted"
// and "confirmed" both stay active — a customer can ask about payment,
// method, or timing right up through a confirmed booking — only
// "completed"/"cancelled" stop matching by default. See
// reopenRecentClosedDealIfMatching for the one deliberate exception.
export const ACTIVE_DEAL_STATUSES: readonly DealStatus[] = ["open", "quoted", "confirmed"];

// Forward-only rank used by advanceDealStatus (service.ts) — a deal's
// status only ever moves up this scale automatically; it never regresses
// (e.g. a defensive re-price on an already-confirmed deal must never
// silently downgrade it back to "quoted"). "completed" and "cancelled"
// share the top rank deliberately: both are terminal from
// advanceDealStatus's point of view — only closeDeal (an explicit,
// separate action) ever sets either of them.
export const DEAL_STATUS_RANK: Record<DealStatus, number> = {
  open: 0,
  quoted: 1,
  confirmed: 2,
  completed: 3,
  cancelled: 3,
};

// The subset of an inbound message's extracted fields the matching
// algorithm needs — never the full TransferRequestExtractedFields shape
// (that's transfer-requests' own concern, per ADR 0002; this module reads
// only what it needs to decide which deal a message belongs to).
export const dealMatchCandidateSchema = z.object({
  pickup: z.string().trim().min(1).optional(),
  destination: z.string().trim().min(1).optional(),
  date: z.string().trim().min(1).optional(),
});
export type DealMatchCandidate = z.infer<typeof dealMatchCandidateSchema>;

export const findMatchingDealForMessageInputSchema = z.object({
  tenantId: z.string().uuid(),
  clientId: z.string().uuid(),
  candidate: dealMatchCandidateSchema,
});
export type FindMatchingDealForMessageInput = z.infer<typeof findMatchingDealForMessageInputSchema>;
