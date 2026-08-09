export const agentCategories = [
  "crm",
  "marketing",
  "ncc",
  "finance",
  "content",
  "platform",
] as const;

export type AgentCategory = (typeof agentCategories)[number];

export const aiCategories = {
  CRM: "crm",
  MARKETING: "marketing",
  NCC: "ncc",
  FINANCE: "finance",
  CONTENT: "content",
  PLATFORM: "platform",
} as const;
