import { AgentOrchestrator, ToolRegistry } from "@bos/ai";
import { marketingAgent } from "./agents/marketing-agent";
import { socialAgent } from "./agents/social-agent";
import { operationsAgent } from "./agents/operations-agent";
import { createRetryFacebookOnlyTool, createPrepareSocialContentTool } from "./tools/social-tools";
import { getConfiguredImageGenerator } from "./image-generator";
import { DbSharedMemory } from "./db-memory";

// ToolRegistry has no per-tenant state of its own (ctx.tenantId is passed
// at call time, per ToolContext — see @bos/ai/tools.ts), so it's a real
// process-lifetime singleton, same lazy-init-once pattern
// marketing/ai-analyst.ts already uses for its own orchestrator.
let toolRegistry: ToolRegistry | null = null;

export function getToolRegistry(): ToolRegistry {
  if (toolRegistry) return toolRegistry;

  toolRegistry = new ToolRegistry();
  toolRegistry.register(createRetryFacebookOnlyTool());
  toolRegistry.register(createPrepareSocialContentTool(getConfiguredImageGenerator()));

  return toolRegistry;
}

// AgentOrchestrator, unlike ToolRegistry, IS constructed fresh per call —
// it holds a SharedMemory instance in its constructor options, and memory
// must be tenant-scoped (DbSharedMemory(tenantId), see db-memory.ts's own
// header comment on tenant isolation). A single shared instance across
// tenants would mean picking one tenant's memory for everyone, which ADR
// 0004 explicitly rules out. Re-registering three agents on a fresh
// AgentRegistry per call is negligible overhead (in-memory Map inserts,
// no I/O) — far simpler and safer than trying to swap memory on a
// long-lived singleton between calls.
export function buildOrchestrator(tenantId: string): AgentOrchestrator {
  const orchestrator = new AgentOrchestrator({
    memory: new DbSharedMemory(tenantId),
    permissionGrants: ["agent:invoke", "agent:discover", "task:execute"],
  });

  orchestrator.registerAgent(marketingAgent);
  orchestrator.registerAgent(socialAgent);
  orchestrator.registerAgent(operationsAgent);

  return orchestrator;
}
