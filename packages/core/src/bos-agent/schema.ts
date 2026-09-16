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

export type TriggerNowInput = z.infer<typeof triggerNowSchema>;
export type ListRunsInput = z.infer<typeof listRunsSchema>;
