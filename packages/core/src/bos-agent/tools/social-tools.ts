import { z } from "zod";
import type { ToolDefinition } from "@bos/ai";
import { retryFacebookOnly, getRealPostDataSnapshot } from "../../social-publishing";
import { briefForTheme, type ImageGenerator } from "../image-generator";

// Thin wrappers only — the real logic (Graph API call, idempotency, tenant
// scoping) already lives in and is already tested by
// packages/core/src/social-publishing/service.ts. A tool here must never
// duplicate that logic, only declare enough metadata for the orchestrator's
// Policy Engine to reason about it before calling straight through.

const retryFacebookOnlyInputSchema = z.object({ postId: z.string().uuid() });
const retryFacebookOnlyOutputSchema = z.object({
  ok: z.boolean(),
  alreadyPublished: z.boolean(),
  facebookPostId: z.string().nullable(),
  error: z.string().nullable(),
});

export function createRetryFacebookOnlyTool(): ToolDefinition<
  z.infer<typeof retryFacebookOnlyInputSchema>,
  z.infer<typeof retryFacebookOnlyOutputSchema>
> {
  return {
    name: "social.retry_facebook_only",
    description:
      "Retries only the Facebook publish step of one existing social_posts row, reusing its already-saved content. Never touches Instagram (see social-publishing/service.ts's retryFacebookOnly).",
    inputSchema: retryFacebookOnlyInputSchema,
    outputSchema: retryFacebookOnlyOutputSchema,
    // requires_approval AND reversible:false are both set, deliberately
    // redundant with each other and with the Policy Engine's own hardcoded
    // "irreversible actions always require approval" rule — a real
    // Facebook post, once published, cannot be un-published by this
    // system. Defense in depth: even if one signal were ever dropped by
    // mistake, the other still gates it.
    riskLevel: "requires_approval",
    category: "content_publish",
    requiresApproval: true,
    reversible: false,
    handler: async (input, ctx) => {
      const result = await retryFacebookOnly(ctx.tenantId, input.postId);
      if (!result) {
        throw new Error(`social.retry_facebook_only: post ${input.postId} not found for this tenant`);
      }
      return {
        ok: result.ok,
        alreadyPublished: result.alreadyPublished,
        facebookPostId: result.facebookPostId,
        error: result.error,
      };
    },
    // VERIFICATION: re-reads nothing extra — retryFacebookOnly's own return
    // value already reflects the post-action DB state (see that function's
    // own read-back-after-write pattern), so verification here is just
    // "did the call itself report success."
    verify: async (output) => ({ ok: output.ok, reason: output.ok ? undefined : (output.error ?? "unknown failure") }),
  };
}

const prepareContentInputSchema = z.object({});
const prepareContentOutputSchema = z.object({
  servedRoutesCount: z.number().int(),
  themes: z.array(z.string()),
  image: z.object({
    ok: z.boolean(),
    theme: z.string().nullable(),
    brief: z.string().nullable(),
    url: z.string().nullable(),
    provider: z.string(),
  }),
});

// Auto-approved: produces no external side effect (no publish, no
// social_posts write) — purely reads real BOS data and prepares a theme +
// image brief for a human/the weekly pipeline to use, per the "content ->
// image" step of the founder's requested flow. Deliberately does not
// generate post copy (content-generator.ts's job, tied to the weekly
// pipeline's own idempotent social_posts row) or touch any row — this is
// preparation only, never a second content-generation/publish path.
export function createPrepareSocialContentTool(
  imageGenerator: ImageGenerator,
): ToolDefinition<z.infer<typeof prepareContentInputSchema>, z.infer<typeof prepareContentOutputSchema>> {
  return {
    name: "social.prepare_content",
    description:
      "Reads real served-route data (never invented) and prepares a candidate theme + image brief for the next social post. Never publishes, never writes to social_posts.",
    inputSchema: prepareContentInputSchema,
    outputSchema: prepareContentOutputSchema,
    riskLevel: "low_risk",
    category: "content_generation",
    requiresApproval: false,
    reversible: true,
    handler: async (_input, ctx) => {
      const snapshot = await getRealPostDataSnapshot(ctx.tenantId);
      const themes = snapshot.servedRoutes.map((route) => `${route.pickup} -> ${route.destination}`);
      const primaryTheme = themes[0] ?? null;

      if (!primaryTheme) {
        return {
          servedRoutesCount: 0,
          themes: [],
          image: { ok: false, theme: null, brief: null, url: null, provider: "none" },
        };
      }

      const brief = briefForTheme(primaryTheme);
      const generated = await imageGenerator.generate({ theme: primaryTheme, tenantId: ctx.tenantId });

      return {
        servedRoutesCount: snapshot.servedRoutes.length,
        themes,
        image: { ok: generated.ok, theme: primaryTheme, brief, url: generated.url, provider: generated.provider },
      };
    },
  };
}
