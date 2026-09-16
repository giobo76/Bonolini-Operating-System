export const agentCategories = [
  "crm",
  "marketing",
  "ncc",
  "finance",
  "content",
  "platform",
  // Added for the BOS Agent orchestrator (packages/core/src/bos-agent) — see
  // that module's README for what each covers.
  "social",
  "operations",
] as const;

export type AgentCategory = (typeof agentCategories)[number];

export const aiCategories = {
  CRM: "crm",
  MARKETING: "marketing",
  NCC: "ncc",
  FINANCE: "finance",
  CONTENT: "content",
  PLATFORM: "platform",
  SOCIAL: "social",
  OPERATIONS: "operations",
} as const;
