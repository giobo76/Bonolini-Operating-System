import type { AgentDefinition } from "./agent";
import { aiCategories } from "./categories";
import type { AgentCapability } from "./tasks";
import type { PermissionGrant } from "./permissions";
import { analyzeWeeklyMarketingPerformance } from "@bos/core";

export interface GoogleMarketingAnalystPayload {
  ga4PropertyId: string;
  searchConsoleSite: string;
  googleAdsCustomerId: string;
}

const platformCapabilities: AgentCapability[] = ["analysis", "planning"];
const defaultPermissionGrant: PermissionGrant[] = [
  { permission: "agent:invoke" },
  { permission: "agent:discover" },
  { permission: "task:execute" },
];

export const googleMarketingAnalystAgent: AgentDefinition = {
  metadata: {
    id: "google_marketing_analyst.agent",
    name: "Google Marketing Analyst",
    description:
      "Analyzes GA4, Search Console, and Google Ads weekly performance to detect anomalies and generate recommendations.",
    category: aiCategories.MARKETING,
    capabilities: ["marketing", ...platformCapabilities],
    permissions: defaultPermissionGrant,
    version: "0.1.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  handler: async ({ tenantId, payload }) => {
    const data = payload as Record<string, unknown>;
    const ga4PropertyId = typeof data.ga4PropertyId === "string" ? data.ga4PropertyId.trim() : "";
    const searchConsoleSite = typeof data.searchConsoleSite === "string" ? data.searchConsoleSite.trim() : "";
    const googleAdsCustomerId = typeof data.googleAdsCustomerId === "string" ? data.googleAdsCustomerId.trim() : "";

    if (!ga4PropertyId || !searchConsoleSite || !googleAdsCustomerId) {
      throw new Error("ga4PropertyId, searchConsoleSite, and googleAdsCustomerId are required payload fields.");
    }

    const result = await analyzeWeeklyMarketingPerformance(
      tenantId,
      ga4PropertyId,
      searchConsoleSite,
      googleAdsCustomerId,
    );

    return {
      result: result as unknown as Record<string, unknown>,
      logs: ["google marketing analyst agent invoked"],
    };
  },
};
