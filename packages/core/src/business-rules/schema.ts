import { z } from "zod";

export const businessRuleCategorySchema = z.enum([
  "pricing",
  "commercial_relevance",
  "commission_platform",
  "seasonality",
  "priority_weights",
  "other",
]);

export const businessRuleVersionAuthorSchema = z.enum(["owner", "bos_agent"]);

export const createBusinessRuleSchema = z.object({
  key: z.string().trim().min(1),
  category: businessRuleCategorySchema,
});

export const businessRuleIdSchema = z.object({ id: z.string().uuid() });

// Not wired to a tRPC mutation in this phase (see router.ts's own header
// comment) — this is the one function a future BOS-agent analysis calls
// directly, service-to-service, never through tRPC (matching how
// orchestrator.ts calls audit.ts/approvals.ts/memory.ts directly, never
// through the admin-facing router). Kept here as a real, validated schema
// so that future caller has the same input contract discipline every other
// Claude-facing tool in this codebase already has.
export const proposeBusinessRuleVersionSchema = z.object({
  ruleId: z.string().uuid(),
  content: z.record(z.string(), z.unknown()),
  author: businessRuleVersionAuthorSchema,
  proposalReasoning: z.string().trim().min(1).optional(),
  evidenceIds: z.array(z.string().uuid()).optional().default([]),
});

// Governance revision: the BOS may now propose an entirely new rule (an
// opportunity that fits no existing key), not only a new version of one
// that already exists — but exactly like proposeBusinessRuleVersion, the
// result is never anything but status="proposed", and the rule itself
// never becomes official (no `current_version_id`) until the founder
// approves. Same "not wired to tRPC" reasoning as above.
export const proposeNewBusinessRuleSchema = z.object({
  key: z.string().trim().min(1),
  category: businessRuleCategorySchema,
  content: z.record(z.string(), z.unknown()),
  author: businessRuleVersionAuthorSchema,
  proposalReasoning: z.string().trim().min(1).optional(),
  evidenceIds: z.array(z.string().uuid()).optional().default([]),
});

export const approveBusinessRuleVersionSchema = z.object({
  versionId: z.string().uuid(),
  reasoning: z.string().trim().optional(),
});

// Required and non-empty — rule §"Per il rifiuto deve essere possibile
// inserire una motivazione" reads as mandatory for a rejection, unlike
// approval's optional note.
export const rejectBusinessRuleVersionSchema = z.object({
  versionId: z.string().uuid(),
  reasoning: z.string().trim().min(1),
});

export type CreateBusinessRuleInput = z.infer<typeof createBusinessRuleSchema>;
export type ProposeBusinessRuleVersionInput = z.infer<typeof proposeBusinessRuleVersionSchema>;
export type ProposeNewBusinessRuleInput = z.infer<typeof proposeNewBusinessRuleSchema>;
