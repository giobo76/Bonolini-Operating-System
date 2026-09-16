import { TRPCError } from "@trpc/server";
import { router, adminProcedure } from "../trpc";
import { listSocialPostsSchema, retryFacebookOnlySchema } from "./schema";
import { listSocialPosts, runWeeklySocialPost, retryFacebookOnly } from "./service";

export const socialPublishingRouter = router({
  listPosts: adminProcedure
    .input(listSocialPostsSchema)
    .query(({ ctx, input }) => listSocialPosts(ctx.session.profile.tenantId, input.limit)),

  // Manual trigger for testing — runs the exact same idempotent pipeline
  // the Monday cron uses, so a second call the same week is a safe no-op
  // (see service.ts's runWeeklySocialPost), never a second real publish.
  runNow: adminProcedure.mutation(({ ctx }) => runWeeklySocialPost(ctx.session.profile.tenantId)),

  // Retries only the Facebook side of one existing post row (see
  // service.ts's retryFacebookOnly) — never Instagram, never a fresh
  // generation, never runNow's full pipeline.
  retryFacebookOnly: adminProcedure.input(retryFacebookOnlySchema).mutation(async ({ ctx, input }) => {
    const result = await retryFacebookOnly(ctx.session.profile.tenantId, input.id);
    if (!result) throw new TRPCError({ code: "NOT_FOUND" });
    return result;
  }),
});
