export const taskTypes = [
  "lead_capture",
  "campaign_strategy",
  "dispatch_optimization",
  "invoice_review",
  "content_generation",
] as const;

export type TaskType = (typeof taskTypes)[number];

export const agentCapabilities = [
  "crm",
  "marketing",
  "ncc",
  "finance",
  "content",
  "analysis",
  "planning",
] as const;

export type AgentCapability = (typeof agentCapabilities)[number];

export interface TaskRequest {
  taskId: string;
  type: TaskType;
  payload: Record<string, unknown>;
  tenantId: string;
  requestedBy: string;
  requiredCapabilities: AgentCapability[];
}

export interface TaskResult {
  success: boolean;
  output: Record<string, unknown>;
  agentId: string;
  completedAt: string;
}

export interface TaskExecutionContext {
  task: TaskRequest;
  memoryNamespace: string;
  agentId?: string;
  result?: TaskResult;
}
