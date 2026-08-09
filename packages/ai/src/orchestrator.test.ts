import { describe, expect, it } from "vitest";
import { AgentOrchestrator } from "./orchestrator";
import { InMemorySharedMemory } from "./memory";
import type { AgentDefinition } from "./agent";

const testAgent: AgentDefinition = {
  metadata: {
    id: "test.agent",
    name: "Test Agent",
    description: "A lightweight test agent.",
    category: "platform",
    capabilities: ["analysis", "planning"],
    permissions: [{ permission: "agent:invoke" }, { permission: "agent:discover" }, { permission: "task:execute" }],
    version: "0.1.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  handler: async ({ payload }) => ({
    result: { success: true, received: payload },
  }),
};

describe("AgentOrchestrator", () => {
  it("registers and discovers agents", async () => {
    const orchestrator = new AgentOrchestrator({ memory: new InMemorySharedMemory(), permissionGrants: ["agent:discover"] });
    orchestrator.registerAgent(testAgent);

    const discovered = await orchestrator.discoverAgents();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.metadata.id).toBe("test.agent");
  });

  it("invokes a registered agent when permission is granted", async () => {
    const orchestrator = new AgentOrchestrator({ memory: new InMemorySharedMemory(), permissionGrants: ["agent:invoke"] });
    orchestrator.registerAgent(testAgent);

    const output = await orchestrator.invokeAgent("test.agent", { tenantId: "tenant-1", payload: { foo: "bar" }, callerId: "user-1" });
    expect(output.result).toEqual({ success: true, received: { foo: "bar" } });
  });

  it("throws when invocation permission is missing", async () => {
    const orchestrator = new AgentOrchestrator({ memory: new InMemorySharedMemory(), permissionGrants: [] });
    orchestrator.registerAgent(testAgent);

    await expect(
      orchestrator.invokeAgent("test.agent", { tenantId: "tenant-1", payload: { foo: "bar" }, callerId: "user-1" }),
    ).rejects.toThrow("Caller lacks agent:invoke permission.");
  });
});
