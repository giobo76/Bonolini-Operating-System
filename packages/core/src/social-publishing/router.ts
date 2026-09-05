import { router, adminProcedure } from "../trpc";
import { listSocialPostsSchema } from "./schema";
import { listSocialPosts, runWeeklySocialPost } from "./service";

export const socialPublishingRouter = router({
  listPosts: adminProcedure
    .input(listSocialPostsSchema)
    .query(({ ctx, input }) => listSocialPosts(ctx.session.profile.tenantId, input.limit)),

  // Manual trigger for testing — runs the exact same idempotent pipeline
  // the Monday cron uses, so a second call the same week is a safe no-op
  // (see service.ts's runWeeklySocialPost), never a second real publish.
  runNow: adminProcedure.mutation(({ ctx }) => runWeeklySocialPost(ctx.session.profile.tenantId)),
});
