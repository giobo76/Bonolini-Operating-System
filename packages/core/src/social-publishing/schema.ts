import { z } from "zod";

export const socialPostStatusSchema = z.enum(["draft", "validated", "published", "failed"]);

// Mirrors marketing/service.ts's listReports(tenantId, limit) convention —
// a simple limit, not full page/pageSize pagination, since this is an
// admin-only audit list, not a paginated public listing.
export const listSocialPostsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListSocialPostsInput = z.infer<typeof listSocialPostsSchema>;
