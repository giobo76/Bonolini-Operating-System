import { router, adminProcedure } from "../trpc";
import {
  addLinkedResourceSchema,
  resourceIdSchema,
  findingIdSchema,
  listFindingsSchema,
  updateFindingStatusSchema,
} from "./schema";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import * as marketingService from "./service";
import * as businessKpis from "./business-kpis";
import { runCheck } from "./run-check";

export const marketingRouter = router({
  getConnectionStatus: adminProcedure.query(({ ctx }) =>
    marketingService.getConnectionStatus(ctx.session.profile.tenantId),
  ),

  listLinkedResources: adminProcedure.query(({ ctx }) =>
    marketingService.listLinkedResources(ctx.session.profile.tenantId),
  ),

  addLinkedResource: adminProcedure
    .input(addLinkedResourceSchema)
    .mutation(({ ctx, input }) =>
      marketingService.addLinkedResource(ctx.session.profile.tenantId, input),
    ),

  removeLinkedResource: adminProcedure
    .input(resourceIdSchema)
    .mutation(({ ctx, input }) =>
      marketingService.removeLinkedResource(ctx.session.profile.tenantId, input.id),
    ),

  disconnect: adminProcedure.mutation(({ ctx }) =>
    marketingService.disconnectConnection(ctx.session.profile.tenantId),
  ),

  listFindings: adminProcedure
    .input(listFindingsSchema)
    .query(({ ctx, input }) => marketingService.listFindings(ctx.session.profile.tenantId, input)),

  getFinding: adminProcedure
    .input(findingIdSchema)
    .query(({ ctx, input }) => marketingService.getFinding(ctx.session.profile.tenantId, input.id)),

  updateFindingStatus: adminProcedure
    .input(updateFindingStatusSchema)
    .mutation(({ ctx, input }) =>
      marketingService.updateFindingStatus(ctx.session.profile.tenantId, input.id, input.status),
    ),

  getHealthScore: adminProcedure.query(({ ctx }) =>
    marketingService.getCurrentHealthScore(ctx.session.profile.tenantId),
  ),

  listHealthScoreHistory: adminProcedure.query(({ ctx }) =>
    marketingService.listHealthScoreHistory(ctx.session.profile.tenantId),
  ),

  // Business-outcome KPIs (Click → Lead → Quote → Booking → Revenue) — see
  // business-kpis.ts. Cost-per-stage isn't exposed yet: it needs real
  // Google Ads spend data, which isn't integrated.
  getFunnelSummary: adminProcedure.query(({ ctx }) =>
    businessKpis.getFunnelSummary(ctx.session.profile.tenantId),
  ),

  getConversionRates: adminProcedure.query(({ ctx }) =>
    businessKpis.getConversionRates(ctx.session.profile.tenantId),
  ),

  getRevenueBySource: adminProcedure.query(({ ctx }) =>
    businessKpis.getRevenueBySource(ctx.session.profile.tenantId),
  ),

  getLtvBySource: adminProcedure.query(({ ctx }) =>
    businessKpis.getLtvBySource(ctx.session.profile.tenantId),
  ),

  // "Analyze Now" — runs the same check pipeline the scheduled jobs use,
  // synchronously, awaited by the caller. Slower than a normal mutation
  // (calls out to GA4/GTM/Search Console/Claude in sequence) but avoids
  // requiring the Inngest dev server just to test detection manually.
  runCheckNow: adminProcedure.mutation(({ ctx }) =>
    runCheck(ctx.session.profile.tenantId, "on_demand", ctx.session.profile.id),
  ),

  listReports: adminProcedure.query(({ ctx }) => marketingService.listReports(ctx.session.profile.tenantId)),

  getReport: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const report = await marketingService.getReport(ctx.session.profile.tenantId, input.id);
      if (!report) throw new TRPCError({ code: "NOT_FOUND" });
      return report;
    }),
});
