import { TRPCError } from "@trpc/server";
import { router, adminProcedure } from "../trpc";
import { triggerNowSchema, listRunsSchema, runIdSchema, approvalIdSchema, memoryActivitySchema } from "./schema";
import { listRuns, getRun } from "./audit";
import { listPendingApprovals, getApproval, markRejected } from "./approvals";
import { buildOrchestrator, getToolRegistry } from "./registry-instance";
import { runAgentCycle, approveAndExecute } from "./orchestrator";
import { memorySearch } from "./memory";

// admin-only throughout — same tier as marketing's getRealConversionSummary
// (ad spend/marketing-strategy-adjacent data), a deliberately higher bar
// than staffProcedure's admin+dispatcher for day-to-day ops.
export const bosAgentRouter = router({
  status: adminProcedure.query(async ({ ctx }) => {
    const [agents, pendingApprovals] = await Promise.all([
      buildOrchestrator(ctx.session.profile.tenantId).discoverAgents(),
      listPendingApprovals(ctx.session.profile.tenantId),
    ]);

    return {
      agentCount: agents.length,
      toolCount: getToolRegistry().list().length,
      pendingApprovalCount: pendingApprovals.length,
    };
  }),

  agents: adminProcedure.query(async ({ ctx }) => {
    const agents = await buildOrchestrator(ctx.session.profile.tenantId).discoverAgents();
    return agents.map((agent) => agent.metadata);
  }),

  tools: adminProcedure.query(() => {
    return getToolRegistry().list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      riskLevel: tool.riskLevel,
      category: tool.category,
      requiresApproval: tool.requiresApproval,
      reversible: tool.reversible,
      allowedAgents: tool.allowedAgents ?? null,
    }));
  }),

  listRuns: adminProcedure.input(listRunsSchema).query(({ ctx, input }) => listRuns(ctx.session.profile.tenantId, input.limit)),

  getRun: adminProcedure.input(runIdSchema).query(async ({ ctx, input }) => {
    const run = await getRun(ctx.session.profile.tenantId, input.id);
    if (!run) throw new TRPCError({ code: "NOT_FOUND" });
    return run;
  }),

  pendingApprovals: adminProcedure.query(({ ctx }) => listPendingApprovals(ctx.session.profile.tenantId)),

  // Bounded (memorySearch's own cap), namespace-scoped read of
  // agent_memory for the admin UI's "Memory activity" view — never a
  // free-form cross-namespace scan.
  memoryActivity: adminProcedure
    .input(memoryActivitySchema)
    .query(({ ctx, input }) => memorySearch(ctx.session.profile.tenantId, input.namespace, { limit: input.limit })),

  // Approving fulfills the human-approval condition the Policy Engine
  // already required at proposal time, then immediately performs ACTION +
  // VERIFICATION + AUDIT + MEMORY UPDATE for exactly the tool/input the
  // original run proposed (see orchestrator.ts's approveAndExecute) —
  // never a re-derived action, and never executed twice even on a
  // duplicate/retried request (approveAndExecute's own idempotency).
  approve: adminProcedure.input(approvalIdSchema).mutation(async ({ ctx, input }) => {
    const tenantId = ctx.session.profile.tenantId;
    const approval = await getApproval(tenantId, input.id);
    if (!approval) throw new TRPCError({ code: "NOT_FOUND" });

    try {
      const { approval: updated, actionResult, verification, alreadyExecuted } = await approveAndExecute(
        tenantId,
        input.id,
        ctx.session.profile.id,
      );
      return { approval: updated, actionResult, verification, alreadyExecuted };
    } catch (error) {
      throw new TRPCError({ code: "CONFLICT", message: error instanceof Error ? error.message : "approve failed" });
    }
  }),

  reject: adminProcedure.input(approvalIdSchema).mutation(async ({ ctx, input }) => {
    const tenantId = ctx.session.profile.tenantId;
    const approval = await getApproval(tenantId, input.id);
    if (!approval) throw new TRPCError({ code: "NOT_FOUND" });

    try {
      return await markRejected(tenantId, input.id);
    } catch (error) {
      throw new TRPCError({ code: "CONFLICT", message: error instanceof Error ? error.message : "reject failed" });
    }
  }),

  // Manual trigger — same "safe to call twice" spirit as social-
  // publishing's runNow, though each agent's own idempotency here comes
  // from what it does with its output (Marketing/Operations are pure
  // reads; Social's only mutating path is approval-gated, with duplicate-
  // proposal prevention on top — see orchestrator.ts's idempotencyKey
  // dedup) rather than a per-week DB constraint.
  triggerNow: adminProcedure.input(triggerNowSchema).mutation(({ ctx, input }) =>
    runAgentCycle({
      tenantId: ctx.session.profile.tenantId,
      callerId: ctx.session.profile.id,
      agentName: input.agentName,
      trigger: "manual",
    }),
  ),
});
