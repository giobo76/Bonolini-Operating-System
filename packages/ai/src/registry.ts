import type { AgentDefinition } from "./agent";
import type { AgentCapability } from "./tasks";

export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  register(agent: AgentDefinition): void {
    if (this.agents.has(agent.metadata.id)) {
      throw new Error(`Agent with id ${agent.metadata.id} is already registered.`);
    }
    this.agents.set(agent.metadata.id, agent);
  }

  deregister(agentId: string): boolean {
    return this.agents.delete(agentId);
  }

  discover(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  get(agentId: string): AgentDefinition | undefined {
    return this.agents.get(agentId);
  }

  findByCategory(category: string): AgentDefinition[] {
    return this.discover().filter((agent) => agent.metadata.category === category);
  }

  findByCapability(capability: AgentCapability): AgentDefinition[] {
    return this.discover().filter((agent) => agent.metadata.capabilities.includes(capability));
  }
}
