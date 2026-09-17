import { z } from "zod";

export const agentNameSchema = z.enum(["marketing", "social", "operations"]);

export const triggerNowSchema = z.object({ agentName: agentNameSchema });

// Same convention as social-publishing's listSocialPostsSchema — a simple
// limit, not full pagination, for an admin-only audit list.
export const listRunsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const runIdSchema = z.object({ id: z.string().uuid() });
export const approvalIdSchema = z.object({ id: z.string().uuid() });

// Every namespace an agent or approveAndExecute actually writes to (see
// memory.ts's callers) — kept as a fixed, known list rather than an
// arbitrary string so the admin UI's namespace picker and this endpoint
// can never be pointed at an unbounded/unexpected namespace.
export const knownMemoryNamespaces = [
  "marketing",
  "social",
  "operations",
  "marketing-approvals",
  "social-approvals",
  "operations-approvals",
] as const;

export const memoryActivitySchema = z.object({
  namespace: z.enum(knownMemoryNamespaces),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});

export type TriggerNowInput = z.infer<typeof triggerNowSchema>;
export type ListRunsInput = z.infer<typeof listRunsSchema>;
export type MemoryActivityInput = z.infer<typeof memoryActivitySchema>;
