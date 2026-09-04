import { z } from "zod";

export const bookingStatusSchema = z.enum(["confirmed", "completed", "cancelled"]);

export const createBookingSchema = z.object({
  clientId: z.string().uuid(),
  quoteId: z.string().uuid().optional(),
  currency: z.string().default("EUR"),
  finalAmountCents: z.number().int().nonnegative().optional(),
  scheduledAt: z.coerce.date().optional(),
});

// A flexible patch rather than many narrow mutations — this is a minimal
// admin-only skeleton (no dedicated Booking Management UI yet), so one
// endpoint covering every milestone (deposit paid, completed, cancelled,
// invoiced, paid) is simpler than one procedure per milestone.
export const updateBookingSchema = z.object({
  id: z.string().uuid(),
  status: bookingStatusSchema.optional(),
  depositAmountCents: z.number().int().nonnegative().optional(),
  depositPaidAt: z.coerce.date().optional(),
  finalAmountCents: z.number().int().nonnegative().optional(),
  completedAt: z.coerce.date().optional(),
  cancelledAt: z.coerce.date().optional(),
  invoicedAt: z.coerce.date().optional(),
  invoiceAmountCents: z.number().int().nonnegative().optional(),
  paidAt: z.coerce.date().optional(),
  paidAmountCents: z.number().int().nonnegative().optional(),
});

export const bookingIdSchema = z.object({ id: z.string().uuid() });
export const listBookingsForClientSchema = z.object({ clientId: z.string().uuid() });

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type UpdateBookingInput = z.infer<typeof updateBookingSchema>;

// ── Booking Snapshot (transfer_request -> booking) ───────────────────────
// Input for ensureBookingForApprovedTransferRequest, called only from
// transfer-requests' ACCEPT/MODIFY_PRICE — deliberately not CreateBookingInput
// (that schema/mutation stays the pre-existing admin/manual booking path,
// untouched by this milestone). Every field here is already resolved by the
// caller (transfer-requests/service.ts): this function never calls Maps,
// never interprets a timezone, never reads calculatedAmountCents — see
// packages/core/src/transfer-requests/README.md's "Booking Snapshot"
// section for the full rationale.
export const ensureBookingSnapshotSchema = z.object({
  transferRequestId: z.string().uuid(),
  clientId: z.string().uuid(),
  pickup: z.string().trim().min(1),
  destination: z.string().trim().min(1),
  pickupAddress: z.string().trim().min(1).nullable(),
  destinationAddress: z.string().trim().min(1).nullable(),
  customerTripDurationMinutes: z.number().int().nonnegative(),
  scheduledAt: z.date(),
  finalAmountCents: z.number().int().nonnegative(),
  currency: z.string().min(1),
});

export type EnsureBookingSnapshotInput = z.infer<typeof ensureBookingSnapshotSchema>;

// ── Calendar Sync (Google Calendar event -> booking) ─────────────────────
// Input for ensureBookingFromCalendarEvent, called only from
// packages/core/src/calendar's sync orchestrator. Every field here is
// already resolved by the caller (extracted from the event, or resolved
// via clients' findOrCreateClientByPhone) — this function never calls the
// Google Calendar API and never parses event text itself, same separation
// of concerns as ensureBookingForApprovedTransferRequest above.
export const ensureBookingFromCalendarEventSchema = z.object({
  calendarEventId: z.string().trim().min(1),
  clientId: z.string().uuid(),
  pickup: z.string().trim().min(1).nullable(),
  destination: z.string().trim().min(1).nullable(),
  scheduledAt: z.date().nullable(),
  // Null when the event carried no confidently-extractable price — never
  // invented by the caller, never defaulted here either.
  finalAmountCents: z.number().int().nonnegative().nullable(),
  currency: z.string().min(1).default("EUR"),
});

export type EnsureBookingFromCalendarEventInput = z.infer<typeof ensureBookingFromCalendarEventSchema>;

export const cancelBookingByCalendarEventIdSchema = z.object({
  calendarEventId: z.string().trim().min(1),
});
