import { evaluatePolicy, type ToolDefinition } from "@bos/ai";
import { createRun, updateRun, completeRun } from "./audit";
import { createApproval } from "./approvals";
import { buildOrchestrator, getToolRegistry } from "./registry-instance";
import type { AgentCycleOutput, ProposedAction } from "./types";

// The EVENT -> PERCEPTION -> DECISION -> POLICY CHECK -> ACTION ->
// VERIFICATION -> AUDIT loop, made concrete. This is the one place all
// seven stages exist together — every stage before this file lived only
// inside an individual agent (PERCEPTION/DECISION) or a pure policy
// function (POLICY CHECK); this file sequences them and persists the
// outcome after each one, exactly like social-publishing/service.ts's
// runWeeklySocialPost sequences generation/validation/publishing (same
// "orchestration function only sequences, each concern owns its own
// logic" discipline, one level up).

export type AgentTrigger = "manual" | "cron" | "event";

export interface RunAgentCycleInput {
  tenantId: string;
  callerId: string;
  agentName: "marketing" | "social" | "operations";
  trigger: AgentTrigger;
  eventType?: string;
  payload?: Record<string, unknown>;
}

export interface RunAgentCycleResult {
  runId: string;
  status: "success" | "failed" | "pending_approval" | "denied";
  decision: unknown;
  policyResult: unknown;
  actionResult: unknown;
  verification: unknown;
  error?: string;
}

async function executeTool(
  tool: ToolDefinition,
  rawInput: unknown,
  ctx: { tenantId: string; callerId: string },
): Promise<{ output: unknown; verification: { ok: boolean; reason?: string } }> {
  const input = tool.inputSchema.parse(rawInput);
  const rawOutput = await tool.handler(input, ctx);
  const output = tool.outputSchema.parse(rawOutput);

  const verification = tool.verify ? await tool.verify(output, ctx) : { ok: true };
  return { output, verification };
}

const AGENT_ID_BY_NAME: Record<RunAgentCycleInput["agentName"], string> = {
  marketing: "marketing.agent",
  social: "social.agent",
  operations: "operations.agent",
};

export async function runAgentCycle(input: RunAgentCycleInput): Promise<RunAgentCycleResult> {
  // EVENT: `input` itself is the event this cycle is reacting to (a manual
  // trigger, a cron tick, or a domain event — see packages/jobs/src/
  // events.ts for the event catalog).
  const run = await createRun({
    tenantId: input.tenantId,
    agentName: input.agentName,
    trigger: input.trigger,
    eventType: input.eventType,
    input: input.payload ?? {},
  });

  try {
    // PERCEPTION + DECISION: delegated to the agent's own handler
    // (@bos/ai's AgentOrchestrator.invokeAgent) — each agent gathers its
    // own real data and makes its own Claude call; this file never reads a
    // data snapshot or calls Claude directly.
    const agentOrchestrator = buildOrchestrator(input.tenantId);
    const agentOutput = await agentOrchestrator.invokeAgent(AGENT_ID_BY_NAME[input.agentName], {
      tenantId: input.tenantId,
      payload: input.payload ?? {},
      callerId: input.callerId,
    });

    const cycleOutput = agentOutput.result as unknown as AgentCycleOutput;
    await updateRun(input.tenantId, run.id, { perception: cycleOutput.perception, decision: cycleOutput.decision });

    const proposedAction: ProposedAction | undefined = cycleOutput.proposedAction;

    if (!proposedAction) {
      // Advisory-only run (Marketing/Operations Agents in this version,
      // and Social Agent when it recommends 'none') — nothing to act on,
      // nothing to verify. Success means "the assessment completed", not
      // "an action was taken."
      const completed = await completeRun(input.tenantId, run.id, "success");
      return {
        runId: run.id,
        status: completed.status as RunAgentCycleResult["status"],
        decision: cycleOutput.decision,
        policyResult: null,
        actionResult: null,
        verification: null,
      };
    }

    const tool = getToolRegistry().get(proposedAction.toolName);
    if (!tool) {
      const completed = await completeRun(input.tenantId, run.id, "failed", {
        toolName: proposedAction.toolName,
        error: `unknown tool: ${proposedAction.toolName}`,
      });
      return {
        runId: run.id,
        status: completed.status as RunAgentCycleResult["status"],
        decision: cycleOutput.decision,
        policyResult: null,
        actionResult: null,
        verification: null,
        error: completed.error ?? undefined,
      };
    }

    // POLICY CHECK — never trusts the tool's own riskLevel/requiresApproval
    // declaration alone; see policy.ts's own header comment for why.
    const policyDecision = evaluatePolicy({
      toolName: tool.name,
      category: tool.category,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      reversible: tool.reversible,
      amountCents: proposedAction.amountCents,
    });

    await updateRun(input.tenantId, run.id, { policyResult: policyDecision, toolName: tool.name });

    if (!policyDecision.allowed) {
      const completed = await completeRun(input.tenantId, run.id, "denied", { error: policyDecision.reason });
      return {
        runId: run.id,
        status: completed.status as RunAgentCycleResult["status"],
        decision: cycleOutput.decision,
        policyResult: policyDecision,
        actionResult: null,
        verification: null,
        error: policyDecision.reason,
      };
    }

    if (policyDecision.requiresApproval) {
      // ACTION deferred: a human must approve before the tool ever runs.
      // The exact, already-validated input is stored on the approval row
      // so approving it later (see approvals.ts + router.ts's `approve`
      // procedure) replays precisely this proposal, never a re-derived one.
      const parsedInput = tool.inputSchema.parse(proposedAction.input);
      await createApproval({
        tenantId: input.tenantId,
        agentRunId: run.id,
        requestedAction: tool.name,
        risk: tool.riskLevel,
        reason: policyDecision.reason,
        payload: parsedInput,
      });
      const completed = await completeRun(input.tenantId, run.id, "pending_approval");
      return {
        runId: run.id,
        status: completed.status as RunAgentCycleResult["status"],
        decision: cycleOutput.decision,
        policyResult: policyDecision,
        actionResult: null,
        verification: null,
      };
    }

    // ACTION (auto-approved path — read_only/low_risk/reversible only,
    // per evaluatePolicy's own rules).
    const { output: actionResult, verification } = await executeTool(tool, proposedAction.input, {
      tenantId: input.tenantId,
      callerId: input.callerId,
    });

    // VERIFICATION already computed above; AUDIT is this final write.
    const completed = await completeRun(input.tenantId, run.id, verification.ok ? "success" : "failed", {
      action: actionResult as object,
      verification,
      error: verification.ok ? undefined : verification.reason,
    });

    return {
      runId: run.id,
      status: completed.status as RunAgentCycleResult["status"],
      decision: cycleOutput.decision,
      policyResult: policyDecision,
      actionResult,
      verification,
      error: completed.error ?? undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await completeRun(input.tenantId, run.id, "failed", { error: message });
    throw error;
  }
}

// Executes an already-approved agent_approvals row — the resume half of
// the deferred-ACTION path above. Never re-runs PERCEPTION/DECISION/POLICY
// CHECK: the tool and its exact input were already fixed at approval-
// request time; this only performs ACTION + VERIFICATION + AUDIT on them,
// using the tenant/tool the original run already established as safe to
// attempt (the Policy Engine already ran once, when the approval was
// created — approving a request does not re-evaluate policy, it fulfills
// the human-approval condition that policy already said was required).
export async function executeApprovedAction(
  tenantId: string,
  agentRunId: string,
  toolName: string,
  payload: unknown,
): Promise<{ actionResult: unknown; verification: { ok: boolean; reason?: string } }> {
  const tool = getToolRegistry().get(toolName);
  if (!tool) {
    throw new Error(`executeApprovedAction: unknown tool ${toolName}`);
  }

  const { output: actionResult, verification } = await executeTool(tool, payload, { tenantId, callerId: "approval" });

  await completeRun(tenantId, agentRunId, verification.ok ? "success" : "failed", {
    action: actionResult as object,
    verification,
    error: verification.ok ? undefined : verification.reason,
  });

  return { actionResult, verification };
}
