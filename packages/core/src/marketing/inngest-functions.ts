import { inngest } from "@bos/jobs";
import type { GetStepTools } from "inngest";
import { getDb, tenants } from "@bos/db";
import { runCheck, type CheckRunType } from "./run-check";
import { runWeeklyReport } from "./weekly-report";
import { captureException, log } from "../observability";

type Step = GetStepTools<typeof inngest>;

async function listAllTenantIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db.select({ id: tenants.id }).from(tenants);
  return rows.map((r) => r.id);
}

// Runs one tenant's unit of work inside step.run() so Inngest memoizes it —
// if this function is retried (timeout, crash, transient platform error),
// already-completed tenants are skipped rather than re-processed, which
// previously risked duplicate check_runs rows and duplicate critical-alert/
// weekly-digest emails. Catches per-tenant so one tenant's failure (e.g. an
// expired Google connection) doesn't stop siblings in the same run from
// being checked — consistent with how run-check.ts already isolates
// per-resource failures inside a single tenant's check.
async function runForEachTenant(
  step: Step,
  stepPrefix: string,
  logEvent: string,
  work: (tenantId: string) => Promise<unknown>,
): Promise<Array<{ tenantId: string; ok: boolean }>> {
  const tenantIds = await step.run("list-tenants", listAllTenantIds);
  const results: Array<{ tenantId: string; ok: boolean }> = [];

  for (const tenantId of tenantIds) {
    try {
      await step.run(`${stepPrefix}-${tenantId}`, () => work(tenantId));
      log(`${logEvent}.success`, { tenantId });
      results.push({ tenantId, ok: true });
    } catch (error) {
      captureException(error, `${logEvent}.failed`, { tenantId });
      results.push({ tenantId, ok: false });
    }
  }

  return results;
}

function runCheckOfType(runType: CheckRunType) {
  return (tenantId: string) => runCheck(tenantId, runType);
}

// Every 3-4 hours, per the agreed cadence. Cron is in the server's
// timezone (UTC in most hosting) — adjust if that matters once deployed.
export const marketingQuickCheck = inngest.createFunction(
  { id: "marketing-quick-check" },
  { cron: "0 */4 * * *" },
  async ({ step }) => {
    log("marketing.quick_check.start");
    return runForEachTenant(step, "quick-check", "marketing.quick_check", runCheckOfType("quick_check"));
  },
);

// Once daily. 06:00 server time — arbitrary, pick a time that makes sense
// once this is actually deployed and the server's timezone is known.
export const marketingDailyAudit = inngest.createFunction(
  { id: "marketing-daily-audit" },
  { cron: "0 6 * * *" },
  async ({ step }) => {
    log("marketing.daily_audit.start");
    return runForEachTenant(step, "daily-audit", "marketing.daily_audit", runCheckOfType("daily_audit"));
  },
);

// Once weekly, Monday morning.
export const marketingWeeklyReport = inngest.createFunction(
  { id: "marketing-weekly-report" },
  { cron: "0 7 * * 1" },
  async ({ step }) => {
    log("marketing.weekly_report.start");
    return runForEachTenant(step, "weekly-report", "marketing.weekly_report", runWeeklyReport);
  },
);

export const marketingInngestFunctions = [
  marketingQuickCheck,
  marketingDailyAudit,
  marketingWeeklyReport,
];
