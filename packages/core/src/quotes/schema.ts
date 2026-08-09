import { z } from "zod";

export const quoteStatusSchema = z.enum(["draft", "sent", "accepted", "declined", "expired"]);

export const createQuoteSchema = z.object({
  clientId: z.string().uuid(),
  amountCents: z.number().int().nonnegative().optional(),
  currency: z.string().default("EUR"),
  notes: z.string().trim().optional(),
  status: quoteStatusSchema.default("draft"),
});

export const updateQuoteStatusSchema = z.object({
  id: z.string().uuid(),
  status: quoteStatusSchema,
});

export const quoteIdSchema = z.object({ id: z.string().uuid() });
export const listQuotesForClientSchema = z.object({ clientId: z.string().uuid() });

export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;
