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
