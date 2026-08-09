import { TRPCError } from "@trpc/server";
import { router, staffProcedure } from "../trpc";
import {
  bookingIdSchema,
  createBookingSchema,
  listBookingsForClientSchema,
  updateBookingSchema,
} from "./schema";
import * as bookingService from "./service";

export const bookingsRouter = router({
  create: staffProcedure
    .input(createBookingSchema)
    .mutation(({ ctx, input }) => bookingService.createBooking(ctx.session.profile.tenantId, input)),

  listForClient: staffProcedure
    .input(listBookingsForClientSchema)
    .query(({ ctx, input }) =>
      bookingService.listBookingsForClient(ctx.session.profile.tenantId, input.clientId),
    ),

  get: staffProcedure.input(bookingIdSchema).query(async ({ ctx, input }) => {
    const booking = await bookingService.getBooking(ctx.session.profile.tenantId, input.id);
    if (!booking) throw new TRPCError({ code: "NOT_FOUND" });
    return booking;
  }),

  update: staffProcedure.input(updateBookingSchema).mutation(async ({ ctx, input }) => {
    const updated = await bookingService.updateBooking(ctx.session.profile.tenantId, input);
    if (!updated) throw new TRPCError({ code: "NOT_FOUND" });
    return updated;
  }),
});
