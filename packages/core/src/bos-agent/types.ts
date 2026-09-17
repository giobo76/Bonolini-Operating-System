// Shared shapes every agent handler and the orchestrator agree on. Kept
// here (not in @bos/ai) because they reference this package's own tool
// naming/payload conventions — @bos/ai's AgentOutput.result stays untyped
// Record<string, unknown> at the package-boundary, same as
// google-marketing-analyst.ts already does; these types describe what this
// package's own agents put inside that record.

export interface ProposedAction {
  toolName: string;
  input: unknown;
  // Surfaced separately from `input` so the Policy Engine's monetary
  // threshold check (packages/ai/src/policy.ts) never has to guess which
  // field of an arbitrary input payload might be an amount.
  amountCents?: number;
}

// A memory write the agent judges worth keeping for its own future runs —
// the agent decides WHAT is worth remembering (semantic judgment, e.g.
// "this assessment", "this recurring error"); the orchestrator performs
// the actual write and records it in agent_runs.memoryOps (mechanical/
// audit responsibility), per memory.ts's own header comment on why memory
// writes are audited there and not inside memory.ts itself. `namespace`
// defaults to the agent's own name if omitted.
export interface MemoryWrite {
  namespace?: string;
  key: string;
  kind: "decision" | "run_result" | "open_issue" | "resolved_issue" | "proposed_action" | "approval_outcome" | "context";
  summary: string;
  data?: Record<string, unknown>;
}

// What an agent handler's AgentOutput.result carries, per stage of the
// EVENT -> PERCEPTION -> DECISION -> ... loop the orchestrator persists.
// `proposedAction` is omitted (never present) for a purely advisory run —
// see marketing-agent.ts/operations-agent.ts, which never set it at all in
// this version.
export interface AgentCycleOutput {
  perception: Record<string, unknown>;
  decision: Record<string, unknown>;
  proposedAction?: ProposedAction;
  memoryWrites?: MemoryWrite[];
}
