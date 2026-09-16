import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry, type ToolDefinition } from "./tools";

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "test.tool",
    description: "A test tool.",
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    riskLevel: "read_only",
    category: "read",
    requiresApproval: false,
    reversible: true,
    handler: async () => ({}),
    ...overrides,
  };
}

describe("ToolRegistry", () => {
  it("registers and retrieves a tool by name", () => {
    const registry = new ToolRegistry();
    registry.register(tool());

    expect(registry.get("test.tool")).toBeDefined();
    expect(registry.get("test.tool")?.name).toBe("test.tool");
  });

  it("returns undefined for an unregistered tool name", () => {
    const registry = new ToolRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("throws when registering the same tool name twice", () => {
    const registry = new ToolRegistry();
    registry.register(tool());
    expect(() => registry.register(tool())).toThrow("already registered");
  });

  it("lists every registered tool", () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: "a" }));
    registry.register(tool({ name: "b" }));

    expect(registry.list().map((t) => t.name).sort()).toEqual(["a", "b"]);
  });

  it("filters tools by category", () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: "reader", category: "read" }));
    registry.register(tool({ name: "spender", category: "spend" }));

    expect(registry.findByCategory("spend").map((t) => t.name)).toEqual(["spender"]);
  });
});
