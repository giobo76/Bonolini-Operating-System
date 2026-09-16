import { inngest } from "@bos/jobs";
import { getDb, tenants } from "@bos/db";
import { runAgentCycle, type RunAgentCycleInput } from "./orchestrator";
import { captureException, log } from "../observability";

async function listAllTenantIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db.select({ id: tenants.id }).from(tenants);
  return rows.map((r) => r.id);
}

// Same per-tenant step.run() discipline as social-publishing/calendar/
// marketing's own crons — a retry only re-runs the tenant that actually
// failed. Each agentCycle run is its own audit row regardless (see
// orchestrator.ts's createRun), so re-executing an already-succeeded
// tenant on a genuine retry produces a second, harmless advisory run —
// "idempotent" here means "never duplicates a real-world effect," which
// holds because every mutating path (currently only
// social.retry_facebook_only) is approval-gated, never auto-executed by
// this cron itself.
function makeDailyCheck(
  id: string,
  agentName: RunAgentCycleInput["agentName"],
) {
  return inngest.createFunction({ id }, { cron: "TZ=Europe/Rome 0 8 * * *" }, async ({ step }) => {
    log(`bos_agent.${agentName}.cron.start`);
    const tenantIds = await step.run("list-tenants", listAllTenantIds);
    const results: Array<{ tenantId: string; ok: boolean }> = [];

    for (const tenantId of tenantIds) {
      try {
        await step.run(`${id}-${tenantId}`, () =>
          runAgentCycle({ tenantId, callerId: "system", agentName, trigger: "cron" }),
        );
        results.push({ tenantId, ok: true });
      } catch (error) {
        captureException(error, `bos_agent.${agentName}.cron.tenant_failed`, { tenantId });
        results.push({ tenantId, ok: false });
      }
    }

    return results;
  });
}

// Morning check, before the social-publishing cron (Monday 09:00 Europe/
// Rome) and independent of it — this never calls runWeeklySocialPost or
// social-publishing's own cron, only the Social Agent's own advisory
// review (see agents/social-agent.ts).
export const bosAgentDailyMarketingCheck = makeDailyCheck("bos-agent-daily-marketing-check", "marketing");
export const bosAgentDailyOperationsCheck = makeDailyCheck("bos-agent-daily-operations-check", "operations");
export const bosAgentDailySocialCheck = makeDailyCheck("bos-agent-daily-social-check", "social");

export const bosAgentInngestFunctions = [
  bosAgentDailyMarketingCheck,
  bosAgentDailyOperationsCheck,
  bosAgentDailySocialCheck,
];
