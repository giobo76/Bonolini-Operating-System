import { inngest } from "@bos/jobs";
import { getDb, tenants } from "@bos/db";
import { runWeeklySocialPost } from "./service";
import { captureException, log } from "../observability";

async function listAllTenantIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db.select({ id: tenants.id }).from(tenants);
  return rows.map((r) => r.id);
}

// Monday 09:00 Europe/Rome — the "TZ=<IANA zone>" prefix is Inngest's own
// documented cron syntax (inngest.com/docs/guides/scheduled-functions),
// needed because every other cron in this codebase runs in the server's own
// timezone (see marketing/inngest-functions.ts's own note), which this
// feature's requirement ("Monday at 09:00 Europe/Rome") cannot assume.
export const socialWeeklyPost = inngest.createFunction(
  { id: "social-weekly-post" },
  { cron: "TZ=Europe/Rome 0 9 * * 1" },
  async ({ step }) => {
    log("social_publishing.weekly_post.cron.start");
    const tenantIds = await step.run("list-tenants", listAllTenantIds);
    const results: Array<{ tenantId: string; ok: boolean }> = [];

    // Each tenant's run is memoized in its own step.run() — same discipline
    // as marketing's quick-check/daily-audit/weekly-report and calendar's
    // sync cron — so a retry only re-runs the tenant that actually failed,
    // and runWeeklySocialPost's own DB-level idempotency (UNIQUE(tenant_id,
    // week_start_date)) means even a genuine re-execution of an
    // already-completed tenant converges on the same row rather than
    // publishing a second post.
    for (const tenantId of tenantIds) {
      try {
        await step.run(`social-weekly-post-${tenantId}`, () => runWeeklySocialPost(tenantId));
        results.push({ tenantId, ok: true });
      } catch (error) {
        captureException(error, "social_publishing.weekly_post.cron.tenant_failed", { tenantId });
        results.push({ tenantId, ok: false });
      }
    }

    return results;
  },
);

export const socialPublishingInngestFunctions = [socialWeeklyPost];
