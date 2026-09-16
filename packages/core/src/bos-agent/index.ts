export { bosAgentRouter } from "./router";
export { bosAgentInngestFunctions } from "./inngest-functions";
export { runAgentCycle } from "./orchestrator";
export type { RunAgentCycleInput, RunAgentCycleResult, AgentTrigger } from "./orchestrator";
export * from "./schema";
export type { AgentRun, AgentApproval } from "@bos/db";

// Module boundary rule (ADR 0002): other modules/apps import only from
// here. registry-instance.ts, audit.ts, approvals.ts, db-memory.ts, and
// every file under agents/ and tools/ are internal — router.ts and
// inngest-functions.ts (both exported above) are the only entry points
// that touch them, same discipline every other module in this repo
// follows for its own service.ts internals.
