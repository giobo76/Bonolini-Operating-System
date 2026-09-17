import { getTransferRequest } from "../transfer-requests";
import { memorySearch, type MemoryRecord } from "./memory";
import type { RunAgentCycleInput } from "./orchestrator";

// Centralized so an agent receives only the entities an event actually
// concerns (never "load everything and let the prompt sort it out") plus
// a small, relevant slice of memory (see memory.ts's own bounding rules)
// — the "memory retrieval intelligente" requirement: which memory is
// relevant is derived from the event/payload, not a blanket dump of the
// agent's whole namespace.

export interface AgentContext {
  entities: Record<string, unknown>;
  memory: MemoryRecord[];
  // What was actually queried — kept alongside the results so a caller
  // (orchestrator.ts's memoryOps audit log) can report truthfully what was
  // read without guessing keys back out of MemoryRecord's own content
  // (which never stores its own storage key).
  memoryNamespace: string;
}

// Bounded at 5 — an agent's DECISION prompt gets a short, targeted recall,
// not memory.ts's own general-purpose cap of 20.
const CONTEXT_MEMORY_LIMIT = 5;

export async function buildContext(input: RunAgentCycleInput): Promise<AgentContext> {
  const entities: Record<string, unknown> = {};
  const payload = input.payload ?? {};

  // Event-driven runs carry the specific entity that triggered them —
  // resolve it now so the agent reasons about that one real record,
  // instead of re-deriving "which request/post is this about" itself.
  const transferRequestId = payload.transferRequestId;
  if (input.agentName === "operations" && typeof transferRequestId === "string") {
    const transferRequest = await getTransferRequest(input.tenantId, transferRequestId);
    if (transferRequest) {
      entities.transferRequest = transferRequest;
    } else {
      entities.transferRequestNotFound = transferRequestId;
    }
  }

  // Memory recall: scoped to this agent's own namespace, and further
  // narrowed to the specific entity's key when one is known (e.g. this
  // exact transfer request or social post), rather than every record the
  // agent has ever written. Falls back to "recent, unscoped" only when no
  // specific entity is in play (a plain cron/manual trigger).
  const namespace = input.agentName;
  let memory: MemoryRecord[];
  if (transferRequestId && typeof transferRequestId === "string") {
    memory = await memorySearch(input.tenantId, namespace, {
      limit: CONTEXT_MEMORY_LIMIT,
      filter: (record) => record.data?.transferRequestId === transferRequestId,
    });
  } else {
    memory = await memorySearch(input.tenantId, namespace, { limit: CONTEXT_MEMORY_LIMIT });
  }

  return { entities, memory, memoryNamespace: namespace };
}
