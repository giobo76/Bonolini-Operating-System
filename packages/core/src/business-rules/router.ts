import { TRPCError } from "@trpc/server";
import { router, adminProcedure } from "../trpc";
import { createBusinessRuleSchema, businessRuleIdSchema, approveBusinessRuleVersionSchema, rejectBusinessRuleVersionSchema } from "./schema";
import { createBusinessRule, listBusinessRules, getBusinessRule, approveBusinessRuleVersion, rejectBusinessRuleVersion } from "./service";

// admin-only throughout — same tier as bos-agent's own router (business
// rules are strategic/commercial data the founder owns exclusively, see
// this module's README's "Governance" section).
//
// Deliberately no `propose` mutation here. proposeBusinessRuleVersion
// (service.ts) is the entry point a future BOS-agent analysis calls
// directly, service-to-service — exactly like orchestrator.ts calls
// audit.ts/approvals.ts/memory.ts directly, never through this
// human-facing router. Exposing it here would mean either (a) trusting an
// HTTP caller's own claim of `author`, which this router will never do, or
// (b) hardcoding author="owner" for a capability nothing in this phase's
// UI spec asks for. Add it deliberately, with that decision made
// explicitly, if a later phase needs the founder to hand-author a proposal
// through the admin UI.
export const businessRulesRouter = router({
  list: adminProcedure.query(({ ctx }) => listBusinessRules(ctx.session.profile.tenantId)),

  get: adminProcedure.input(businessRuleIdSchema).query(async ({ ctx, input }) => {
    const rule = await getBusinessRule(ctx.session.profile.tenantId, input.id);
    if (!rule) throw new TRPCError({ code: "NOT_FOUND" });
    return rule;
  }),

  create: adminProcedure
    .input(createBusinessRuleSchema)
    .mutation(({ ctx, input }) => createBusinessRule(ctx.session.profile.tenantId, input)),

  // Approves AND activates in one call (see service.ts's own comment on
  // why Phase 1 collapses those two steps) — the founder's one "APPROVA"
  // action in the admin UI.
  approve: adminProcedure.input(approveBusinessRuleVersionSchema).mutation(async ({ ctx, input }) => {
    try {
      return await approveBusinessRuleVersion(
        ctx.session.profile.tenantId,
        input.versionId,
        ctx.session.profile.id,
        input.reasoning,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "approve failed";
      throw new TRPCError({ code: message.includes("not found") ? "NOT_FOUND" : "CONFLICT", message });
    }
  }),

  reject: adminProcedure.input(rejectBusinessRuleVersionSchema).mutation(async ({ ctx, input }) => {
    try {
      return await rejectBusinessRuleVersion(
        ctx.session.profile.tenantId,
        input.versionId,
        ctx.session.profile.id,
        input.reasoning,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "reject failed";
      throw new TRPCError({ code: message.includes("not found") ? "NOT_FOUND" : "CONFLICT", message });
    }
  }),
});
