import { AgentRegistry } from "./registry";
import { hasPermission, type AgentPermission } from "./permissions";
import type { AgentDefinition, AgentInput, AgentOutput } from "./agent";
import type { SharedMemory } from "./memory";
import type { TaskRequest, TaskResult } from "./tasks";

export interface OrchestratorOptions {
  memory: SharedMemory;
  permissionGrants?: AgentPermission[];
}

export class AgentOrchestrator {
  private readonly registry = new AgentRegistry();

  constructor(private readonly options: OrchestratorOptions) {}

  registerAgent(agent: AgentDefinition): void {
    this.registry.register(agent);
  }

  async invokeAgent(agentId: string, input: AgentInput): Promise<AgentOutput> {
    const agent = this.registry.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found.`);
    }

    if (!hasPermission(this.options.permissionGrants ?? [], "agent:invoke")) {
      throw new Error("Caller lacks agent:invoke permission.");
    }

    return agent.handler(input);
  }

  async discoverAgents(): Promise<AgentDefinition[]> {
    if (!hasPermission(this.options.permissionGrants ?? [], "agent:discover")) {
      throw new Error("Caller lacks agent:discover permission.");
    }

    return this.registry.discover();
  }

  async executeTask(task: TaskRequest): Promise<TaskResult> {
    const candidates = this.registry.discover().filter((agent) =>
      task.requiredCapabilities.every((capability) => agent.metadata.capabilities.includes(capability)),
    );

    if (candidates.length === 0) {
      throw new Error("No agent available for requested task capabilities.");
    }

    const selected = candidates[0];
    if (!selected) {
      throw new Error("No agent matched the required capabilities.");
    }

    const output = await selected.handler({
      tenantId: task.tenantId,
      payload: task.payload,
      callerId: task.requestedBy,
    });

    return {
      success: true,
      output: output.result,
      agentId: selected.metadata.id,
      completedAt: new Date().toISOString(),
    };
  }
}
