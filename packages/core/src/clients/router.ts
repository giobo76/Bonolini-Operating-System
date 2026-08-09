import { TRPCError } from "@trpc/server";
import { router, staffProcedure, publicProcedure } from "../trpc";
import {
  clientIdSchema,
  createClientSchema,
  leadSubmissionSchema,
  listClientsSchema,
  updateClientSchema,
} from "./schema";
import * as clientService from "./service";

export const clientsRouter = router({
  list: staffProcedure
    .input(listClientsSchema)
    .query(({ ctx, input }) => clientService.listClients(ctx.session.profile.tenantId, input)),

  get: staffProcedure.input(clientIdSchema).query(async ({ ctx, input }) => {
    const client = await clientService.getClient(ctx.session.profile.tenantId, input.id);
    if (!client) throw new TRPCError({ code: "NOT_FOUND" });
    return client;
  }),

  create: staffProcedure
    .input(createClientSchema)
    .mutation(({ ctx, input }) => clientService.createClient(ctx.session.profile.tenantId, input)),

  update: staffProcedure.input(updateClientSchema).mutation(async ({ ctx, input }) => {
    const updated = await clientService.updateClient(ctx.session.profile.tenantId, input);
    if (!updated) throw new TRPCError({ code: "NOT_FOUND" });
    return updated;
  }),

  softDelete: staffProcedure.input(clientIdSchema).mutation(async ({ ctx, input }) => {
    const deleted = await clientService.softDeleteClient(ctx.session.profile.tenantId, input.id);
    if (!deleted) throw new TRPCError({ code: "NOT_FOUND" });
    return deleted;
  }),

  restore: staffProcedure.input(clientIdSchema).mutation(async ({ ctx, input }) => {
    const restored = await clientService.restoreClient(ctx.session.profile.tenantId, input.id);
    if (!restored) throw new TRPCError({ code: "NOT_FOUND" });
    return restored;
  }),

  // Public on purpose — transfer-web's unauthenticated "Request a Quote"
  // form. Narrow input schema (leadSubmissionSchema) is what keeps this
  // safe to leave open, not a role check. No rate-limiting/spam protection
  // yet — a real gap, flagged rather than silently ignored.
  submitLead: publicProcedure
    .input(leadSubmissionSchema)
    .mutation(({ input }) => clientService.submitLead(input)),
});
