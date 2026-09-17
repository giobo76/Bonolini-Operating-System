import type { z } from "zod";
import type { RiskLevel, ActionCategory } from "./policy";

// Thin, generic wrapper metadata around an already-existing, already-tested
// function elsewhere in the codebase (packages/core's own service
// functions) — a tool never contains new business logic itself, it only
// declares enough about an existing capability for the orchestrator/Policy
// Engine to reason about it before calling it. Same dependency-inversion
// shape as google-marketing-analyst.ts: this package stays free of
// @bos/core/@bos/db imports, so TInput/TOutput/the handler's real logic are
// always supplied by the caller in packages/core.
export interface ToolContext {
  tenantId: string;
  callerId: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  // The tool's own claim about itself — the Policy Engine (see policy.ts)
  // must never trust this alone for the categories it hardcodes a deny/
  // require-approval rule for; it's an additional signal, not the sole
  // gate. See evaluatePolicy's doc comment.
  riskLevel: RiskLevel;
  category: ActionCategory;
  requiresApproval: boolean;
  reversible: boolean;
  // V2 — this ToolRegistry doubles as the "Action Registry": which
  // agent(s) may even propose this tool. Enforced by evaluatePolicy (see
  // policy.ts's PolicyAction.allowedAgents), not by convention — the
  // orchestrator always passes the calling agent's name through. Omit to
  // leave a tool unrestricted by this particular rule (still subject to
  // every other Policy Engine check).
  allowedAgents?: readonly string[];
  // V2 — derives a stable dedup key from a proposed call's input, so the
  // orchestrator can recognize "this is the same underlying action already
  // pending approval" (e.g. the same postId) instead of piling up duplicate
  // agent_approvals rows every time a cron/event run re-proposes it. Omit
  // for a tool where duplicate proposals are meaningless or harmless.
  getIdempotencyKey?: (input: TInput) => string;
  handler: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
  // VERIFICATION step, declared per-tool since what "confirms the action
  // really happened" is action-specific. Optional: a tool that omits this
  // is verified simply by its handler having returned without throwing.
  verify?: (output: TOutput, ctx: ToolContext) => Promise<{ ok: boolean; reason?: string }>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  // Generic on the call site, not the stored value — a ToolDefinition's
  // input/output types only matter to the code that builds and calls it
  // directly (see tools/social-tools.ts); once registered, the registry
  // and orchestrator always treat it as ToolDefinition<unknown, unknown>
  // (the type this method actually stores), same erasure @bos/ai's own
  // AgentRegistry already applies to AgentDefinition.
  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool with name ${tool.name} is already registered.`);
    }
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  findByCategory(category: ActionCategory): ToolDefinition[] {
    return this.list().filter((tool) => tool.category === category);
  }
}
