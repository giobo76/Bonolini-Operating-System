import type { AgentDefinition } from "./agent";
import { aiCategories } from "./categories";
import type { AgentCapability } from "./tasks";
import type { PermissionGrant } from "./permissions";
import { googleMarketingAnalystAgent } from "./google-marketing-analyst";

const platformCapabilities: AgentCapability[] = ["analysis", "planning"];

const defaultPermissionGrant: PermissionGrant[] = [
  { permission: "agent:invoke" },
  { permission: "agent:discover" },
  { permission: "task:execute" },
];

export const crmAgent: AgentDefinition = {
  metadata: {
    id: "crm.agent",
    name: "CRM Agent",
    description: "Manages customer relationship tasks, lead qualification, and lifecycle updates.",
    category: aiCategories.CRM,
    capabilities: ["crm", ...platformCapabilities],
    permissions: defaultPermissionGrant,
    version: "0.1.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  handler: async ({ payload }) => {
    return {
      result: {
        summary: "CRM Agent processed payload",
        payload,
      },
      logs: ["crm agent invoked"],
    };
  },
};

export const marketingAgent: AgentDefinition = {
  metadata: {
    id: "marketing.agent",
    name: "Marketing Agent",
    description: "Builds campaign strategies, marketing analytics, and outreach plans.",
    category: aiCategories.MARKETING,
    capabilities: ["marketing", ...platformCapabilities],
    permissions: defaultPermissionGrant,
    version: "0.1.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  handler: async ({ payload }) => {
    return {
      result: {
        summary: "Marketing Agent prepared strategy",
        payload,
      },
      logs: ["marketing agent invoked"],
    };
  },
};

export * from "./google-marketing-analyst";

export const nccAgent: AgentDefinition = {
  metadata: {
    id: "ncc.agent",
    name: "NCC Agent",
    description: "Handles chauffeur dispatch, route planning, and service coordination.",
    category: aiCategories.NCC,
    capabilities: ["ncc", ...platformCapabilities],
    permissions: defaultPermissionGrant,
    version: "0.1.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  handler: async ({ payload }) => {
    return {
      result: {
        summary: "NCC Agent created dispatch suggestions",
        payload,
      },
      logs: ["ncc agent invoked"],
    };
  },
};

export const financeAgent: AgentDefinition = {
  metadata: {
    id: "finance.agent",
    name: "Finance Agent",
    description: "Reviews invoices, compliance, and billing workflows.",
    category: aiCategories.FINANCE,
    capabilities: ["finance", ...platformCapabilities],
    permissions: defaultPermissionGrant,
    version: "0.1.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  handler: async ({ payload }) => {
    return {
      result: {
        summary: "Finance Agent reviewed billing payload",
        payload,
      },
      logs: ["finance agent invoked"],
    };
  },
};

export const contentAgent: AgentDefinition = {
  metadata: {
    id: "content.agent",
    name: "Content Agent",
    description: "Generates copy, descriptions, and marketing content assets.",
    category: aiCategories.CONTENT,
    capabilities: ["content", ...platformCapabilities],
    permissions: defaultPermissionGrant,
    version: "0.1.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  handler: async ({ payload }) => {
    return {
      result: {
        summary: "Content Agent generated draft output",
        payload,
      },
      logs: ["content agent invoked"],
    };
  },
};

export const coreAgents: AgentDefinition[] = [
  crmAgent,
  marketingAgent,
  nccAgent,
  financeAgent,
  contentAgent,
  googleMarketingAnalystAgent,
];

export function registerCoreAgents(orchestrator: import("./orchestrator").AgentOrchestrator) {
  coreAgents.forEach((agent) => orchestrator.registerAgent(agent));
}
