import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, staffProcedure } from "../trpc";
import {
  approveQuoteRound,
  confirmDepositReceived,
  getRoundForPanel,
  listPendingForPanel,
  rejectQuoteRound,
  reviseQuoteRound,
} from "./service";

// Admin panel "Preventivi in attesa". staffProcedure (admin + dispatcher),
// the same tier as transferRequests.accept/reject/modifyPrice. The approver
// recorded is the logged-in profile.
const roundIdSchema = z.object({ id: z.string().uuid() });

export const quoteApprovalRouter = router({
  pending: staffProcedure.query(({ ctx }) => listPendingForPanel(ctx.session.profile.tenantId)),

  get: staffProcedure.input(roundIdSchema).query(async ({ ctx, input }) => {
    const detail = await getRoundForPanel(ctx.session.profile.tenantId, input.id);
    if (!detail) throw new TRPCError({ code: "NOT_FOUND" });
    return detail;
  }),

  approve: staffProcedure
    .input(roundIdSchema)
    .mutation(({ ctx, input }) => approveQuoteRound(ctx.session.profile.tenantId, input.id, ctx.session.profile.id)),

  reject: staffProcedure
    .input(roundIdSchema)
    .mutation(({ ctx, input }) => rejectQuoteRound(ctx.session.profile.tenantId, input.id)),

  // depositCents omitted = 50% of the new price, nearest 10 €.
  revise: staffProcedure
    .input(
      roundIdSchema.extend({
        amountCents: z.number().int().positive(),
        depositCents: z.number().int().positive().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      reviseQuoteRound(ctx.session.profile.tenantId, input.id, input.amountCents, input.depositCents ?? null, {
        notify: false,
      }),
    ),

  // "Acconto ricevuto": confirms the booking and sends the customer the
  // automatic confirmation, exactly like the WhatsApp button.
  confirmDeposit: staffProcedure
    .input(z.object({ bookingId: z.string().uuid(), receivedAmountCents: z.number().int().positive().optional() }))
    .mutation(({ ctx, input }) =>
      confirmDepositReceived(ctx.session.profile.tenantId, input.bookingId, input.receivedAmountCents),
    ),
});
