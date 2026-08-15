import { and, eq } from "drizzle-orm";
import {
  getDb,
  checkRuns,
  findings as findingsTable,
  marketingLinkedResources,
  assertOne,
} from "@bos/db";
import * as websiteChecks from "./checks/website-checks";
import * as ga4Checks from "./checks/ga4-checks";
import * as gtmChecks from "./checks/gtm-checks";
import * as searchConsoleChecks from "./checks/search-console-checks";
import * as attributionChecks from "./checks/attribution-checks";
import * as googleAdsChecks from "./checks/google-ads-checks";
import { runGoogleMarketingAnalyst } from "./ai-analyst";
import { sendCriticalAlertEmail } from "./alerts";
import { createFinding, recordHealthScoreSnapshot } from "./service";
import type { FindingDraft } from "./rule-types";

export type CheckRunType = "quick_check" | "daily_audit" | "on_demand";

function apiErrorDraft(resourceType: string, externalId: string, error: unknown): FindingDraft {
  return {
    dedupeKey: `api_error:${resourceType}:${externalId}`,
    category: "account_health",
    nature: "technical_issue",
    severity: "medium",
    confidenceScore: 70,
    title: `Could not check ${resourceType.replace(/_/g, " ")}`,
    observation: `The ${resourceType.replace(/_/g, " ")} check for ${externalId} failed: ${error instanceof Error ? error.message : String(error)}`,
    rootCause:
      "Likely an expired/revoked Google connection (see /marketing/connections), a misconfigured resource ID, or a transient Google API error.",
    businessImpact: "This data source isn't being monitored until the underlying issue is fixed.",
    financialImpact: null,
    recommendedActions: [
      "Check /marketing/connections — reconnect if the status shows needs_reauth",
      "Verify the resource ID is correct",
    ],
    requiresApproval: false,
    expectedBenefit: "Restores monitoring coverage for this data source.",
    evidence: { resourceType, externalId, error: String(error) },
  };
}

// The single entry point both the Inngest scheduled functions and the
// "Analyze Now" tRPC mutation call — one code path, two triggers.
export async function runCheck(
  tenantId: string,
  runType: CheckRunType,
  triggeredBy?: string,
) {
  const db = getDb();
  const runRows = await db
    .insert(checkRuns)
    .values({ tenantId, runType, triggeredBy, status: "running" })
    .returning();
  const run = assertOne(runRows, "runCheck: create check_runs row");

  try {
    const resources = await db
      .select()
      .from(marketingLinkedResources)
      .where(and(eq(marketingLinkedResources.tenantId, tenantId), eq(marketingLinkedResources.active, true)));

    const drafts: FindingDraft[] = [];

    for (const resource of resources) {
      try {
        if (resource.resourceType === "ga4_property") {
          drafts.push(...(await ga4Checks.runChecks(tenantId, resource.externalId)));
        } else if (resource.resourceType === "gtm_container") {
          drafts.push(...(await gtmChecks.runChecks(tenantId, resource.externalId)));
        } else if (resource.resourceType === "search_console_site") {
          drafts.push(...(await searchConsoleChecks.runChecks(tenantId, resource.externalId)));
        } else if (resource.resourceType === "google_ads_account") {
          drafts.push(...(await googleAdsChecks.runChecks(tenantId, resource.externalId)));
        }
      } catch (error) {
        drafts.push(apiErrorDraft(resource.resourceType, resource.externalId, error));
      }
    }

    // Not tied to a specific linked resource — checks transfer-web's own
    // key pages directly.
    drafts.push(...(await websiteChecks.runChecks()));
    drafts.push(...(await attributionChecks.runChecks(tenantId)));

    // AI Analyst synthesis only on daily_audit/on_demand — quick_check stays
    // fast and cheap, per the original cadence design (reserve the LLM
    // call for judgment, not every 4-hour rule pass). Goes through @bos/ai
    // (see ai-analyst.ts) instead of calling strategist.ts directly, so the
    // Google Marketing Analyst agent is the single strategic-synthesis
    // layer sitting above every deterministic check, not a second pipeline.
    if (runType === "daily_audit" || runType === "on_demand") {
      drafts.push(...(await runGoogleMarketingAnalyst(tenantId, drafts, triggeredBy ?? "system")));
    }

    const openFindings = await db
      .select()
      .from(findingsTable)
      .where(and(eq(findingsTable.tenantId, tenantId), eq(findingsTable.status, "open")));

    const openByKey = new Map(
      openFindings.map((f) => [
        `${f.category}:${(f.evidence as Record<string, unknown> | null)?.dedupeKey ?? ""}`,
        f,
      ]),
    );

    let criticalCount = 0;
    const criticalDrafts: FindingDraft[] = [];

    for (const draft of drafts) {
      const key = `${draft.category}:${draft.dedupeKey}`;
      const existing = openByKey.get(key);

      if (existing) {
        await db
          .update(findingsTable)
          .set({ lastSeenAt: new Date(), confidenceScore: draft.confidenceScore, updatedAt: new Date() })
          .where(eq(findingsTable.id, existing.id));
      } else {
        const { dedupeKey, evidence, ...rest } = draft;
        await createFinding(tenantId, {
          ...rest,
          checkRunId: run.id,
          evidence: { ...(evidence ?? {}), dedupeKey },
        });
      }

      if (draft.severity === "critical") {
        criticalCount += 1;
        criticalDrafts.push(draft);
      }
    }

    await recordHealthScoreSnapshot(tenantId, run.id);

    if (criticalDrafts.length > 0) {
      await sendCriticalAlertEmail(criticalDrafts);
    }

    await db
      .update(checkRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        summary: `${drafts.length} finding(s), ${criticalCount} critical`,
      })
      .where(eq(checkRuns.id, run.id));

    return { checkRunId: run.id, findingsCount: drafts.length, criticalCount };
  } catch (error) {
    await db
      .update(checkRuns)
      .set({ status: "failed", completedAt: new Date(), errorMessage: String(error) })
      .where(eq(checkRuns.id, run.id));
    throw error;
  }
}
