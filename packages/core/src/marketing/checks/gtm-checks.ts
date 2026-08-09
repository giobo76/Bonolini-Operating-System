import { resolveGtmContainer } from "../google-clients";
import type { FindingDraft } from "../rule-types";

// Honest limitation: the Tag Manager API can tell us about *configuration*
// state (published vs. draft, workspace changes pending) but not whether a
// tag is actually *firing correctly at runtime* on the live site — that
// needs GTM's own Preview/Debug mode or a headless-browser check of the
// real page, neither of which this pass implements. "Broken tags or
// triggers" is therefore only partially covered here.
export async function runChecks(tenantId: string, publicContainerId: string): Promise<FindingDraft[]> {
  const drafts: FindingDraft[] = [];
  const { tagmanager, path } = await resolveGtmContainer(tenantId, publicContainerId);

  const liveVersion = await tagmanager.accounts.containers.versions
    .live({ parent: path })
    .catch(() => null);

  if (!liveVersion?.data) {
    drafts.push({
      dedupeKey: `gtm_no_live_version:${publicContainerId}`,
      category: "gtm_configuration",
      nature: "technical_issue",
      severity: "critical",
      confidenceScore: 75,
      title: "GTM container has no published (live) version",
      observation: `Container ${publicContainerId} has no live version currently published.`,
      rootCause: "The container may never have been published, or the live version was removed.",
      businessImpact: "No GTM tags are firing on the site at all — every tag that depends on GTM is broken.",
      financialImpact: { amount: null, currency: "EUR", period: "daily", direction: "cost" },
      recommendedActions: ["Publish a container version in Google Tag Manager immediately"],
      requiresApproval: false,
      expectedBenefit: "Restores all GTM-dependent tracking.",
      evidence: { publicContainerId },
    });
  }

  const workspaces = await tagmanager.accounts.containers.workspaces.list({ parent: path });

  for (const workspace of workspaces.data.workspace ?? []) {
    if (!workspace.path) continue;
    const status = await tagmanager.accounts.containers.workspaces
      .getStatus({ path: workspace.path })
      .catch(() => null);
    const changeCount = status?.data.workspaceChange?.length ?? 0;

    if (changeCount > 0) {
      drafts.push({
        dedupeKey: `gtm_unpublished:${publicContainerId}:${workspace.workspaceId}`,
        category: "gtm_configuration",
        nature: "technical_issue",
        severity: "medium",
        confidenceScore: 90,
        title: "GTM workspace has unpublished changes",
        observation: `Workspace "${workspace.name}" in container ${publicContainerId} has ${changeCount} unpublished change(s).`,
        rootCause: "Someone edited tags/triggers/variables in GTM but hasn't published the container.",
        businessImpact:
          "Whatever was changed (potentially a tracking fix or a new tag) is not live on the site yet.",
        financialImpact: null,
        recommendedActions: [
          "Review the pending changes in GTM",
          "Publish the workspace once the changes are confirmed ready",
        ],
        requiresApproval: false,
        expectedBenefit: "Ensures GTM configuration matches what's actually intended to be live.",
        evidence: { publicContainerId, workspaceId: workspace.workspaceId, changeCount },
      });
    }
  }

  return drafts;
}
