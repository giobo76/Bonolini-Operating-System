import type { PermissionGrant } from "./permissions";
import type { AgentCategory } from "./categories";
import type { AgentCapability } from "./tasks";

export type AgentStatus = "idle" | "busy" | "unavailable";

export interface AgentMetadata {
  id: string;
  name: string;
  description: string;
  category: AgentCategory;
  capabilities: AgentCapability[];
  permissions: PermissionGrant[];
  version: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentInput {
  tenantId: string;
  payload: Record<string, unknown>;
  callerId: string;
}

export interface AgentOutput {
  result: Record<string, unknown>;
  logs?: string[];
}

export type AgentHandler = (input: AgentInput) => Promise<AgentOutput>;

export interface AgentDefinition {
  metadata: AgentMetadata;
  handler: AgentHandler;
}
