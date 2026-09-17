import { randomUUID } from "node:crypto";
import { evaluatePolicy, type ToolDefinition } from "@bos/ai";
import { createRun, updateRun, completeRun } from "./audit";
import {
  createApproval,
  getApproval,
  markApproved,
  markExecuted,
  markExecutionFailed,
  findApprovalByIdempotencyKey,
} from "./approvals";
import { buildOrchestrator, getToolRegistry } from "./registry-instance";
import { buildContext } from "./context-builder";
import { memorySet, type MemoryRecord } from "./memory";
import type { AgentCycleOutput, ProposedAction, MemoryWrite } from "./types";

// The EVENT -> CONTEXT -> MEMORY -> SPECIALIST AGENT -> DECISION -> POLICY
// -> ACTION/APPROVAL/NO ACTION -> AUDIT -> MEMORY UPDATE loop (V2). This is
// the one place all stages exist together — every stage before this file
// lives inside an individual agent (DECISION), a pure policy function
// (POLICY), or a small dedicated module (context-builder.ts, memory.ts);
// this file sequences them and persists the outcome after each one, same
// "orchestrator only sequences, each concern owns its own logic"
// discipline social-publishing/service.ts's runWeeklySocialPost already
// follows, one level up.

export type AgentTrigger = "manual" | "cron" | "event";
export type AgentName = "marketing" | "social" | "operations";

export interface RunAgentCycleInput {
  tenantId: string;
  callerId: string;
  agentName: AgentName;
  trigger: AgentTrigger;
  eventType?: string;
  // Threads this cycle to whatever caused it (an emitted event's own id,
  // or a fresh uuid for a manual/cron trigger with no natural one) — see
  // agent_runs.correlationId's own schema comment. Generated automatically
  // when omitted, never required of a caller.
  correlationId?: string;
  payload?: Record<string, unknown>;
}

export interface RunAgentCycleResult {
  runId: string;
  correlationId: string;
  // "validation_failed" is a TS-level-only distinction (no new DB enum
  // value) — the underlying agent_runs.status column stores "failed" for
  // this case too (genuinely true: the run did fail), but the error
  // column carries a "validation_failed: " prefix and this field exposes
  // it as its own literal so a caller never has to string-match `error` to
  // tell it apart from a real execution failure.
  status: "success" | "failed" | "pending_approval" | "denied" | "validation_failed";
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

const AGENT_ID_BY_NAME: Record<AgentName, string> = {
  marketing: "marketing.agent",
  social: "social.agent",
  operations: "operations.agent",
};

interface MemoryOpsLog {
  read: { namespace: string; count: number };
  wrote: Array<{ namespace: string; key: string; summary: string }>;
}

// Persists every memoryWrite the agent's own decision asked for (see
// types.ts's MemoryWrite doc comment for why the agent decides WHAT to
// remember and the orchestrator performs the write) and returns a log of
// what happened, written onto the run's own memoryOps column — the
// "memoria" half of the admin UI's observability requirement.
async function applyMemoryWrites(
  tenantId: string,
  agentName: AgentName,
  writes: MemoryWrite[] | undefined,
  correlationId: string,
): Promise<MemoryOpsLog["wrote"]> {
  if (!writes || writes.length === 0) return [];
  const results: MemoryOpsLog["wrote"] = [];
  for (const write of writes) {
    const namespace = write.namespace ?? agentName;
    const record: Omit<MemoryRecord, "createdAt"> = {
      kind: write.kind,
      agentName,
      summary: write.summary,
      data: write.data,
      correlationId,
    };
    await memorySet(tenantId, namespace, write.key, record);
    results.push({ namespace, key: write.key, summary: write.summary });
  }
  return results;
}

export async function runAgentCycle(input: RunAgentCycleInput): Promise<RunAgentCycleResult> {
  const correlationId = input.correlationId ?? randomUUID();

  // CONTEXT + MEMORY: minimal entity context for the event, plus a
  // bounded, relevant slice of memory (see context-builder.ts) — computed
  // before the run even exists so it can be recorded as this run's own
  // `input`, not silently gathered and discarded.
  const context = await buildContext(input);
  const memoryOps: MemoryOpsLog = {
    read: { namespace: context.memoryNamespace, count: context.memory.length },
    wrote: [],
  };

  const run = await createRun({
    tenantId: input.tenantId,
    agentName: input.agentName,
    trigger: input.trigger,
    eventType: input.eventType,
    correlationId,
    input: input.payload ?? {},
  });

  try {
    // SPECIALIST AGENT + DECISION: delegated to the agent's own handler
    // (@bos/ai's AgentOrchestrator.invokeAgent) — each agent gathers its
    // own real data and makes its own Claude call; this file never reads a
    // data snapshot or calls Claude directly. The built context/memory is
    // passed through payload.context — a plain, loosely-typed field, same
    // boundary @bos/ai's AgentInput.payload already is.
    const agentOrchestrator = buildOrchestrator(input.tenantId);
    const agentOutput = await agentOrchestrator.invokeAgent(AGENT_ID_BY_NAME[input.agentName], {
      tenantId: input.tenantId,
      payload: { ...(input.payload ?? {}), context },
      callerId: input.callerId,
    });

    const cycleOutput = agentOutput.result as unknown as AgentCycleOutput;

    if (cycleOutput.validationFailed) {
      // The model's own output could not be trusted this run (no tool_use
      // block, or it failed the agent's own decisionSchema) — never
      // treated as a real "decided to do nothing" success, and nothing in
      // cycleOutput is applied (no memory write, no proposedAction can
      // exist here by construction — see each agent's own handler).
      await updateRun(input.tenantId, run.id, {
        perception: cycleOutput.perception,
        decision: cycleOutput.decision ?? {},
        memoryOps,
      });
      const completed = await completeRun(input.tenantId, run.id, "failed", {
        error: `validation_failed: ${cycleOutput.validationFailed.reason}`,
      });
      return {
        runId: run.id,
        correlationId,
        status: "validation_failed",
        decision: cycleOutput.decision ?? {},
        policyResult: null,
        actionResult: null,
        verification: null,
        error: completed.error ?? undefined,
      };
    }

    memoryOps.wrote = await applyMemoryWrites(input.tenantId, input.agentName, cycleOutput.memoryWrites, correlationId);
    await updateRun(input.tenantId, run.id, {
      perception: cycleOutput.perception,
      decision: cycleOutput.decision,
      memoryOps,
    });

    const proposedAction: ProposedAction | undefined = cycleOutput.proposedAction;

    if (!proposedAction) {
      // NO ACTION (Marketing/Operations Agents in this version, and Social
      // Agent when it recommends 'none') — nothing to act on, nothing to
      // verify. Success means "the assessment completed", not "an action
      // was taken."
      const completed = await completeRun(input.tenantId, run.id, "success");
      return {
        runId: run.id,
        correlationId,
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
        correlationId,
        status: completed.status as RunAgentCycleResult["status"],
        decision: cycleOutput.decision,
        policyResult: null,
        actionResult: null,
        verification: null,
        error: completed.error ?? undefined,
      };
    }

    // POLICY CHECK — never trusts the tool's own riskLevel/requiresApproval/
    // allowedAgents declaration alone in the sense that this call is the
    // single, mandatory gate every proposed action passes through
    // regardless of caller; no agent handler has any other path to a
    // tool's handler() than through this exact check.
    const policyDecision = evaluatePolicy({
      toolName: tool.name,
      category: tool.category,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      reversible: tool.reversible,
      amountCents: proposedAction.amountCents,
      callerAgent: input.agentName,
      allowedAgents: tool.allowedAgents,
    });

    await updateRun(input.tenantId, run.id, { policyResult: policyDecision, toolName: tool.name });

    if (!policyDecision.allowed) {
      const completed = await completeRun(input.tenantId, run.id, "denied", { error: policyDecision.reason });
      return {
        runId: run.id,
        correlationId,
        status: completed.status as RunAgentCycleResult["status"],
        decision: cycleOutput.decision,
        policyResult: policyDecision,
        actionResult: null,
        verification: null,
        error: policyDecision.reason,
      };
    }

    if (policyDecision.requiresApproval) {
      const parsedInput = tool.inputSchema.parse(proposedAction.input);
      const idempotencyKey = tool.getIdempotencyKey ? `${tool.name}:${tool.getIdempotencyKey(parsedInput)}` : undefined;

      // Duplicate-proposal prevention: a cron/event run re-proposing the
      // exact same action while an earlier proposal is still pending (or
      // already decided) must not pile up a second agent_approvals row.
      if (idempotencyKey) {
        const existing = await findApprovalByIdempotencyKey(input.tenantId, idempotencyKey);
        // Only an existing row still 'pending' counts as a duplicate to
        // avoid — one already-decided (approved/rejected/executed/
        // execution_failed) represents a *past*, completed decision point,
        // not one still in flight; a fresh failure on the same underlying
        // entity later is a legitimate new proposal, not a duplicate of a
        // resolved one. Without this status check, one execution would
        // permanently block ever proposing the same action again.
        if (existing && existing.status === "pending") {
          const completed = await completeRun(input.tenantId, run.id, "pending_approval", {
            error: `duplicate of existing approval ${existing.id} (idempotencyKey ${idempotencyKey}) — no new approval created`,
          });
          return {
            runId: run.id,
            correlationId,
            status: completed.status as RunAgentCycleResult["status"],
            decision: cycleOutput.decision,
            policyResult: policyDecision,
            actionResult: null,
            verification: null,
          };
        }
      }

      // ACTION deferred: a human must approve before the tool ever runs.
      // The exact, already-validated input is stored on the approval row
      // so approveAndExecute replays precisely this proposal, never a
      // re-derived one.
      await createApproval({
        tenantId: input.tenantId,
        agentRunId: run.id,
        requestedAction: tool.name,
        risk: tool.riskLevel,
        reason: policyDecision.reason,
        payload: parsedInput,
        correlationId,
        idempotencyKey,
      });
      const completed = await completeRun(input.tenantId, run.id, "pending_approval");
      return {
        runId: run.id,
        correlationId,
        status: completed.status as RunAgentCycleResult["status"],
        decision: cycleOutput.decision,
        policyResult: policyDecision,
        actionResult: null,
        verification: null,
      };
    }

    // ACTION (auto-approved path — READ_ONLY/PREPARE/AUTONOMOUS_SAFE tiers
    // only, per evaluatePolicy's own rules).
    const { output: actionResult, verification } = await executeTool(tool, proposedAction.input, {
      tenantId: input.tenantId,
      callerId: input.callerId,
    });

    const completed = await completeRun(input.tenantId, run.id, verification.ok ? "success" : "failed", {
      action: actionResult as object,
      verification,
      error: verification.ok ? undefined : verification.reason,
    });

    return {
      runId: run.id,
      correlationId,
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

export interface ApproveAndExecuteResult {
  approval: Awaited<ReturnType<typeof getApproval>>;
  actionResult: unknown;
  verification: { ok: boolean; reason?: string } | null;
  alreadyExecuted: boolean;
}

// The single place that owns the whole "approved -> executed" state
// machine — deliberately not split across the router and a separate
// executor function, which is exactly what would let a double-click (or a
// retried request) re-execute an already-executed tool. Never re-runs
// PERCEPTION/DECISION/POLICY CHECK: the tool and its exact input were
// already fixed at approval-request time; this only performs ACTION +
// VERIFICATION + AUDIT + MEMORY UPDATE on them.
export async function approveAndExecute(
  tenantId: string,
  approvalId: string,
  approvedByProfileId: string,
): Promise<ApproveAndExecuteResult> {
  const existing = await getApproval(tenantId, approvalId);
  if (!existing) {
    throw new Error(`approveAndExecute: no agent_approval found for id ${approvalId}`);
  }

  if (existing.status === "executed" || existing.status === "execution_failed") {
    // Idempotent no-op — the tool already ran once for this approval; a
    // second approve click (or a retried request) must never run it again.
    return { approval: existing, actionResult: null, verification: null, alreadyExecuted: true };
  }
  if (existing.status === "rejected" || existing.status === "expired") {
    throw new Error(`approveAndExecute: agent_approval ${approvalId} is '${existing.status}', cannot be approved`);
  }

  const approved = existing.status === "approved" ? existing : await markApproved(tenantId, approvalId, approvedByProfileId);

  const tool = getToolRegistry().get(approved.requestedAction);
  if (!tool) {
    await markExecutionFailed(tenantId, approvalId);
    await completeRun(tenantId, approved.agentRunId, "failed", { error: `unknown tool: ${approved.requestedAction}` });
    throw new Error(`approveAndExecute: unknown tool ${approved.requestedAction}`);
  }

  try {
    const { output: actionResult, verification } = await executeTool(tool, approved.payload, {
      tenantId,
      callerId: approvedByProfileId,
    });

    await completeRun(tenantId, approved.agentRunId, verification.ok ? "success" : "failed", {
      action: actionResult as object,
      verification,
      error: verification.ok ? undefined : verification.reason,
    });

    const finalApproval = verification.ok
      ? await markExecuted(tenantId, approvalId)
      : await markExecutionFailed(tenantId, approvalId);

    // MEMORY UPDATE: record the real outcome of a human-approved action —
    // e.g. so the Social Agent's next run can see "this exact retry was
    // already approved and executed" rather than re-proposing it.
    if (approved.correlationId) {
      await memorySet(tenantId, `${approved.requestedAction.split(".")[0]}-approvals`, approved.id, {
        kind: "approval_outcome",
        agentName: approved.requestedAction.split(".")[0] ?? "unknown",
        summary: verification.ok
          ? `${approved.requestedAction} executed successfully`
          : `${approved.requestedAction} executed but failed verification: ${verification.reason ?? "unknown"}`,
        data: { approvalId: approved.id, toolName: approved.requestedAction, ok: verification.ok },
        correlationId: approved.correlationId,
      });
    }

    return { approval: finalApproval, actionResult, verification, alreadyExecuted: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await completeRun(tenantId, approved.agentRunId, "failed", { error: message });
    await markExecutionFailed(tenantId, approvalId);
    throw error;
  }
}
