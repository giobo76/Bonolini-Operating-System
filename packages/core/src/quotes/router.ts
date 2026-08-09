import { TRPCError } from "@trpc/server";
import { router, staffProcedure } from "../trpc";
import {
  createQuoteSchema,
  listQuotesForClientSchema,
  quoteIdSchema,
  updateQuoteStatusSchema,
} from "./schema";
import * as quoteService from "./service";

export const quotesRouter = router({
  create: staffProcedure
    .input(createQuoteSchema)
    .mutation(({ ctx, input }) => quoteService.createQuote(ctx.session.profile.tenantId, input)),

  listForClient: staffProcedure
    .input(listQuotesForClientSchema)
    .query(({ ctx, input }) =>
      quoteService.listQuotesForClient(ctx.session.profile.tenantId, input.clientId),
    ),

  get: staffProcedure.input(quoteIdSchema).query(async ({ ctx, input }) => {
    const quote = await quoteService.getQuote(ctx.session.profile.tenantId, input.id);
    if (!quote) throw new TRPCError({ code: "NOT_FOUND" });
    return quote;
  }),

  updateStatus: staffProcedure.input(updateQuoteStatusSchema).mutation(async ({ ctx, input }) => {
    const updated = await quoteService.updateQuoteStatus(
      ctx.session.profile.tenantId,
      input.id,
      input.status,
    );
    if (!updated) throw new TRPCError({ code: "NOT_FOUND" });
    return updated;
  }),
});
