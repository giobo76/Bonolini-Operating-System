import type { AgentDefinition } from "./agent";
import { aiCategories } from "./categories";
import type { AgentCapability } from "./tasks";
import type { PermissionGrant } from "./permissions";

// Dependency-injected on purpose: this package must not import @bos/core
// (packages/core already depends on @bos/ai to invoke this agent — importing
// @bos/core back from here would create a circular package dependency). The
// caller (packages/core/src/marketing/ai-analyst.ts) supplies the actual
// finding-synthesis implementation; this file only defines the agent's
// shape, metadata, and payload contract.
//
// Findings are passed as loosely-typed records rather than a shared
// FindingDraft type, again to avoid @bos/ai depending on @bos/core's/
// @bos/db's domain types. The caller is responsible for casting to/from its
// own concrete finding type at the boundary.
export type GoogleMarketingAnalystSynthesize = (
  findings: Array<Record<string, unknown>>,
) => Promise<Array<Record<string, unknown>>>;

const platformCapabilities: AgentCapability[] = ["analysis", "planning"];
const defaultPermissionGrant: PermissionGrant[] = [
  { permission: "agent:invoke" },
  { permission: "agent:discover" },
  { permission: "task:execute" },
];

export function createGoogleMarketingAnalystAgent(
  synthesize: GoogleMarketingAnalystSynthesize,
): AgentDefinition {
  return {
    metadata: {
      id: "google_marketing_analyst.agent",
      name: "Google Marketing Analyst",
      description:
        "Reviews the marketing findings already collected this run (GA4, GTM, Search Console, Google Ads, website, attribution) and adds strategic findings a senior consultant would notice — patterns, prioritization, and root causes needing judgment.",
      category: aiCategories.MARKETING,
      capabilities: ["marketing", ...platformCapabilities],
      permissions: defaultPermissionGrant,
      version: "0.2.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    handler: async ({ payload }) => {
      const data = payload as Record<string, unknown>;
      const findings = Array.isArray(data.findings) ? (data.findings as Array<Record<string, unknown>>) : [];

      const result = await synthesize(findings);

      return {
        result: { findings: result },
        logs: [`google marketing analyst agent invoked with ${findings.length} input finding(s)`],
      };
    },
  };
}
