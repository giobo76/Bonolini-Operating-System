import { and, eq, gte } from "drizzle-orm";
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

// ── Findings lifecycle: coverage matrix + auto-resolution ──────────────
// Built from an explicit, verified read of every checks/*.ts module (see the
// coverage-matrix analysis this implements) — do not add a prefix here
// without re-verifying it against the actual check that produces it.

// Every dedupeKey prefix a *deterministic* check can produce. quick_check,
// daily_audit, and on_demand all run the exact same deterministic checks
// (see the resource loop + website/attribution calls below) — the only
// run_type-dependent difference in the whole engine is the AI Analyst.
const DETERMINISTIC_PREFIXES = [
  "ga4_event_stopped:",
  "ga4_traffic_drop:",
  "gtm_no_live_version:",
  "gtm_unpublished:",
  "gsc_click_drop:",
  "gsc_indexing:",
  "google_ads:",
  "landing_page_error:",
  "landing_page_slow:",
  "landing_page_unreachable:",
  "attribution_untagged_ratio:",
] as const;

const COVERAGE_BY_RUN_TYPE: Record<CheckRunType, readonly string[]> = {
  quick_check: DETERMINISTIC_PREFIXES,
  daily_audit: [...DETERMINISTIC_PREFIXES, "claude:"],
  on_demand: [...DETERMINISTIC_PREFIXES, "claude:"],
};

// Absolute exclusions from auto-resolution, regardless of run_type coverage:
// - claude:* — dedupeKey is built from the AI Analyst's free-text title
//   (strategist.ts), which is not stable across invocations; "not
//   re-detected" carries no reliable meaning here.
// - gsc_indexing:* — a per-URL inspection failure is swallowed by its own
//   try/catch (search-console-checks.ts) with no signal left behind;
//   "not re-detected" is indistinguishable from "inspection silently failed".
// - gtm_no_live_version:* — the underlying API call is wrapped in
//   `.catch(() => null)` (gtm-checks.ts), so a real API error and a genuine
//   "no live version" are indistinguishable from this finding's absence.
// - api_error:* — this dedupeKey type IS the failure signal for the other
//   four; auto-resolving an error report on its own absence would be circular.
const NEVER_AUTO_RESOLVE_PREFIXES = ["claude:", "gsc_indexing:", "gtm_no_live_version:", "api_error:"] as const;

// Resource-tied dedupeKey prefixes eligible for auto-resolution, mapped to
// the marketingLinkedResources.resourceType that must still be active, and
// the evidence field (already stored on the finding by its originating
// check — see ga4-checks.ts/gtm-checks.ts/search-console-checks.ts/
// google-ads-checks.ts) holding that resource's externalId. Reading the id
// back from evidence, rather than parsing it out of the dedupeKey string, is
// deliberate: siteUrl (search_console_site) can itself contain ":" (its own
// "https://" scheme), which would break a generic dedupeKey-splitting
// approach. gtm_no_live_version and gsc_indexing are absent here — both are
// already excluded above, so they never need a resource lookup.
const RESOURCE_LOOKUP_BY_PREFIX: Record<string, { resourceType: string; evidenceField: string }> = {
  "ga4_event_stopped:": { resourceType: "ga4_property", evidenceField: "propertyId" },
  "ga4_traffic_drop:": { resourceType: "ga4_property", evidenceField: "propertyId" },
  "gtm_unpublished:": { resourceType: "gtm_container", evidenceField: "publicContainerId" },
  "gsc_click_drop:": { resourceType: "search_console_site", evidenceField: "siteUrl" },
  "google_ads:": { resourceType: "google_ads_account", evidenceField: "customerId" },
};

const AUTO_RESOLVE_AFTER_MISSES = 2;
const REOPEN_WINDOW_DAYS = 30;

export function isNeverAutoResolved(dedupeKey: string): boolean {
  return NEVER_AUTO_RESOLVE_PREFIXES.some((prefix) => dedupeKey.startsWith(prefix));
}

export function isCoveredByRunType(dedupeKey: string, runType: CheckRunType): boolean {
  return COVERAGE_BY_RUN_TYPE[runType].some((prefix) => dedupeKey.startsWith(prefix));
}

function findResourceLookup(dedupeKey: string): { resourceType: string; evidenceField: string } | null {
  const prefix = Object.keys(RESOURCE_LOOKUP_BY_PREFIX).find((candidate) => dedupeKey.startsWith(candidate));
  return prefix ? RESOURCE_LOOKUP_BY_PREFIX[prefix]! : null;
}

// Decides whether an open finding that was NOT re-detected in this run can
// be trusted as a genuine "not found" signal — i.e. whether it's safe to
// count as one of the AUTO_RESOLVE_AFTER_MISSES misses. Pure and exported
// specifically to be tested directly, without mocking the database, mirroring
// ga4-checks.ts's severityForBaseline/confidenceForBaseline.
export function isEligibleForMissTracking(params: {
  dedupeKey: string;
  runType: CheckRunType;
  evidence: Record<string, unknown> | null;
  draftsThisRun: FindingDraft[];
  activeResources: Array<{ resourceType: string; externalId: string }>;
}): boolean {
  const { dedupeKey, runType, evidence, draftsThisRun, activeResources } = params;

  if (isNeverAutoResolved(dedupeKey)) return false;
  if (!isCoveredByRunType(dedupeKey, runType)) return false;

  const lookup = findResourceLookup(dedupeKey);
  if (!lookup) return true; // website-checks / attribution-checks: no linked resource to gate on

  const externalId = evidence ? (evidence[lookup.evidenceField] as string | undefined) : undefined;
  if (!externalId) return false; // can't identify the resource — fail closed rather than guess

  const isActive = activeResources.some(
    (resource) => resource.resourceType === lookup.resourceType && resource.externalId === externalId,
  );
  if (!isActive) return false; // administratively deactivated resource — not the same as "problem fixed"

  const hasApiError = draftsThisRun.some(
    (draft) => draft.dedupeKey === `api_error:${lookup.resourceType}:${externalId}`,
  );
  if (hasApiError) return false; // the check didn't actually run successfully this pass

  return true;
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

    // dedupeKeys of the api_error findings this run can vouch for as fixed
    // — the check for that exact resourceType+externalId just completed
    // without throwing. Built from the same template apiErrorDraft() uses,
    // so a match here is guaranteed to identify the same finding, including
    // for search_console_site externalIds that contain their own "://".
    const recoveredApiErrorDedupeKeys = new Set<string>();

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
        } else {
          continue;
        }
        recoveredApiErrorDedupeKeys.add(`api_error:${resource.resourceType}:${resource.externalId}`);
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

    // Every account_health finding regardless of status (open or resolved)
    // — used below to correlate a claude:account_health:* finding's
    // creation time against the real api_error findings' active windows.
    // api_error findings always carry category "account_health" too (see
    // apiErrorDraft), so this single query covers both.
    const accountHealthHistory = await db
      .select()
      .from(findingsTable)
      .where(and(eq(findingsTable.tenantId, tenantId), eq(findingsTable.category, "account_health")));

    const openByKey = new Map(
      openFindings.map((f) => [
        `${f.category}:${(f.evidence as Record<string, unknown> | null)?.dedupeKey ?? ""}`,
        f,
      ]),
    );

    // Resolve api_error findings for resources whose check just succeeded
    // again. Deliberately separate from the miss-based auto-resolve loop
    // below, which excludes api_error entirely (see
    // NEVER_AUTO_RESOLVE_PREFIXES) — that mechanism resolves a finding
    // after N consecutive runs where it's simply absent from `drafts`,
    // which is the wrong signal for api_error: absence there can also mean
    // the resource was unlinked or this run_type doesn't reach it, neither
    // of which means the underlying problem is fixed. Here the signal is
    // unambiguous instead: THIS run's check for THIS exact resource just
    // completed without throwing (see recoveredApiErrorDedupeKeys above),
    // so only that resource's own api_error finding is resolved — never
    // another resource's, and never another finding type's.
    for (const dedupeKey of recoveredApiErrorDedupeKeys) {
      const existingApiError = openByKey.get(`account_health:${dedupeKey}`);
      if (existingApiError) {
        await db
          .update(findingsTable)
          .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
          .where(eq(findingsTable.id, existingApiError.id));
      }
    }

    // The AI Analyst (strategist.ts) only ever creates an account_health
    // finding when that run's deterministic drafts included an api_error OR
    // a google_ads: signal (see AI_REQUIRE_SIGNAL_PRESENT in ai-analyst.ts) —
    // it writes free-text prose every time ("Systemic OAuth token failure
    // across all connected platforms..."), a fresh dedupeKey each run, and
    // carries no evidence linking it back to which of the two signals
    // triggered it (strategist.ts never attaches one). Neither the title/
    // observation text (changes every run, not a stable key) nor "zero
    // api_error findings remain open" alone (too broad — would also resolve
    // a legitimate account_health finding that was actually about a
    // google_ads: performance signal, not the OAuth outage) is a safe
    // criterion on its own. The one structural signal available without
    // inventing a schema field or touching the AI Analyst: whether a real
    // api_error finding (open or already resolved) was active — i.e. its
    // [firstDetectedAt, resolvedAt] window covers this Claude finding's own
    // firstDetectedAt — at the moment this specific commentary was written.
    // That correlates a claude:account_health finding to the OAuth incident
    // using only timestamps already on every finding row, never Claude's
    // wording. claude:* stays (correctly) excluded from the generic
    // miss-based auto-resolve loop below for every other case.
    const remainingOpenApiErrorCount = openFindings.filter((f) => {
      const key = (f.evidence as Record<string, unknown> | null)?.dedupeKey as string | undefined;
      return key?.startsWith("api_error:") && !recoveredApiErrorDedupeKeys.has(key);
    }).length;

    if (recoveredApiErrorDedupeKeys.size > 0 && remainingOpenApiErrorCount === 0) {
      const apiErrorHistory = accountHealthHistory.filter((f) => {
        const key = (f.evidence as Record<string, unknown> | null)?.dedupeKey as string | undefined;
        return key?.startsWith("api_error:");
      });

      const oauthDerivedAiFindings = openFindings.filter((f) => {
        const key = (f.evidence as Record<string, unknown> | null)?.dedupeKey as string | undefined;
        if (f.category !== "account_health" || !key?.startsWith("claude:account_health:")) return false;

        return apiErrorHistory.some((apiError) => {
          const activeSince = apiError.firstDetectedAt.getTime();
          const activeUntil = (apiError.resolvedAt ?? new Date()).getTime();
          const claudeFindingCreatedAt = f.firstDetectedAt.getTime();
          return activeSince <= claudeFindingCreatedAt && claudeFindingCreatedAt <= activeUntil;
        });
      });

      for (const finding of oauthDerivedAiFindings) {
        await db
          .update(findingsTable)
          .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
          .where(eq(findingsTable.id, finding.id));
      }
    }

    // Reopen candidates: findings resolved (by the auto-resolution logic
    // below, or manually) within the last REOPEN_WINDOW_DAYS. Queried once
    // up front, same shape as openByKey, so the per-draft loop stays O(1)
    // per draft instead of querying inside the loop.
    const reopenWindowStart = new Date(Date.now() - REOPEN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const recentlyResolvedFindings = await db
      .select()
      .from(findingsTable)
      .where(
        and(
          eq(findingsTable.tenantId, tenantId),
          eq(findingsTable.status, "resolved"),
          gte(findingsTable.resolvedAt, reopenWindowStart),
        ),
      );

    const resolvedByKey = new Map(
      recentlyResolvedFindings.map((f) => [
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
        // Re-confirming an open finding refreshes its severity/confidence/
        // observation/evidence from the current run's draft, not just
        // last_seen_at — a rule's classification logic can change over time
        // (e.g. the GA4 traffic-drop severity/confidence tiers), and a
        // stale finding should catch up to it next time it's re-detected,
        // rather than staying pinned to whatever the rule produced when it
        // was first created. check_run_id deliberately stays untouched: it
        // still identifies the run that originally created the finding, not
        // the run that last confirmed it. missedCount resets to 0 — being
        // re-detected after a miss (or several) means it's still an active,
        // ongoing issue, not a candidate for auto-resolution anymore.
        await db
          .update(findingsTable)
          .set({
            lastSeenAt: new Date(),
            confidenceScore: draft.confidenceScore,
            severity: draft.severity,
            observation: draft.observation,
            evidence: { ...(draft.evidence ?? {}), dedupeKey: draft.dedupeKey },
            missedCount: 0,
            updatedAt: new Date(),
          })
          .where(eq(findingsTable.id, existing.id));
      } else {
        const reopenCandidate = resolvedByKey.get(key);
        const { dedupeKey, evidence, ...rest } = draft;

        if (reopenCandidate) {
          // Same underlying issue resurfaced within the reopen window — reuse
          // the original row instead of creating a new one, so
          // first_detected_at and check_run_id keep reflecting when this
          // recurring issue was *first* seen, not just this latest bout.
          // Removed from resolvedByKey so a second draft this same run with
          // the same category:dedupeKey (shouldn't happen — each check's
          // dedupeKeys are unique per iteration — but kept defensive) can't
          // reopen the same row twice.
          resolvedByKey.delete(key);
          await db
            .update(findingsTable)
            .set({
              status: "open",
              resolvedAt: null,
              missedCount: 0,
              lastSeenAt: new Date(),
              confidenceScore: draft.confidenceScore,
              severity: draft.severity,
              observation: draft.observation,
              evidence: { ...(evidence ?? {}), dedupeKey },
              updatedAt: new Date(),
            })
            .where(eq(findingsTable.id, reopenCandidate.id));
        } else {
          await createFinding(tenantId, {
            ...rest,
            checkRunId: run.id,
            evidence: { ...(evidence ?? {}), dedupeKey },
          });
        }
      }

      if (draft.severity === "critical") {
        criticalCount += 1;
        criticalDrafts.push(draft);
      }
    }

    // Auto-resolution: open findings whose dedupeKey didn't appear among
    // this run's drafts at all (re-detected findings were already handled
    // above and never reach here). Only a finding this run's coverage can
    // actually vouch for — see isEligibleForMissTracking — gets its
    // missedCount incremented; everything else is left exactly as it was.
    const touchedKeys = new Set(drafts.map((draft) => `${draft.category}:${draft.dedupeKey}`));

    for (const finding of openFindings) {
      const evidence = finding.evidence as Record<string, unknown> | null;
      const key = `${finding.category}:${evidence?.dedupeKey ?? ""}`;
      if (touchedKeys.has(key)) continue;

      const dedupeKey = evidence?.dedupeKey as string | undefined;
      if (!dedupeKey) continue;

      const eligible = isEligibleForMissTracking({
        dedupeKey,
        runType,
        evidence,
        draftsThisRun: drafts,
        activeResources: resources,
      });
      if (!eligible) continue;

      const missedCount = finding.missedCount + 1;

      if (missedCount >= AUTO_RESOLVE_AFTER_MISSES) {
        await db
          .update(findingsTable)
          .set({ status: "resolved", resolvedAt: new Date(), missedCount, updatedAt: new Date() })
          .where(eq(findingsTable.id, finding.id));
      } else {
        await db
          .update(findingsTable)
          .set({ missedCount, updatedAt: new Date() })
          .where(eq(findingsTable.id, finding.id));
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
