import { AgentOrchestrator, InMemorySharedMemory, createGoogleMarketingAnalystAgent } from "@bos/ai";
import { z } from "zod";
import { findingCategorySchema, findingNatureSchema, findingSeveritySchema } from "./schema";
import { runStrategistSynthesis } from "./strategist";
import type { FindingDraft } from "./rule-types";

const AGENT_ID = "google_marketing_analyst.agent";

// Defensive re-validation of whatever comes back through the @bos/ai agent
// boundary (AgentOutput.result is untyped Record<string, unknown>) — a
// malformed entry is dropped, not allowed to corrupt a finding or crash the
// check run. Mirrors the same safety net strategist.ts already applies to
// Claude's raw tool-use output.
const findingLikeSchema = z.object({
  category: findingCategorySchema,
  nature: findingNatureSchema,
  severity: findingSeveritySchema,
  confidenceScore: z.number().int().min(0).max(100),
  title: z.string().min(1),
  observation: z.string().min(1),
  rootCause: z.string().optional(),
  businessImpact: z.string().min(1),
  financialImpact: z.unknown().optional(),
  recommendedActions: z.array(z.string()),
  requiresApproval: z.boolean(),
  expectedBenefit: z.string().optional(),
  evidence: z.unknown().optional(),
  dedupeKey: z.string().min(1),
});

// The actual Claude-calling implementation stays in strategist.ts, untouched
// — this only adapts its (FindingDraft[]) => Promise<FindingDraft[]> shape
// to the loosely-typed Record<string, unknown>[] contract @bos/ai's agent
// expects, so @bos/ai never needs to import this package's domain types.
async function synthesizeAdapter(
  findings: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const drafts = findings as unknown as FindingDraft[];
  const synthesized = await runStrategistSynthesis(drafts);
  return synthesized as unknown as Array<Record<string, unknown>>;
}

// ── Finding-quality gate ─────────────────────────────────────────────
// Claude receives only {category, severity, title, observation} of this
// run's deterministic drafts (see strategist.ts) — never raw metrics, never
// the persisted findings table. Left unchecked, this produces two failure
// modes observed in Production on 2026-08-18: (1) Claude restates a signal
// a deterministic check already covers (e.g. another "organic_traffic"
// finding paraphrasing the same GA4 traffic-drop numbers), and (2) Claude
// proposes a finding in a category no deterministic check actually fired
// for this run (e.g. "budget_waste" when Google Ads produced zero drafts,
// or "search_console_indexing" when the GSC check found nothing) — pure
// speculation with no grounding data behind it.
//
// The gate below is deliberately not an LLM call: it's a second Claude
// invocation to judge Claude's own output that would just move the
// unreliability one level up. It's plain prefix matching against this run's
// *own* deterministic drafts — the same category/dedupeKey vocabulary the
// rest of the engine already uses, no embeddings or similarity scoring.

// organic_traffic is the one category where the deterministic check is
// already the authoritative source for this exact signal — a Claude finding
// in the same category, while this signal is active, is by construction a
// restatement of it, not new information. Presence blocks creation.
const AI_BLOCK_IF_SIGNAL_PRESENT: Partial<Record<FindingDraft["category"], readonly string[]>> = {
  organic_traffic: ["ga4_traffic_drop:", "gsc_click_drop:"],
};

// These categories are where Claude is allowed to add interpretation, but
// only riding on a real deterministic signal from this same run — never
// invented from nothing. Absence blocks creation.
const AI_REQUIRE_SIGNAL_PRESENT: Partial<Record<FindingDraft["category"], readonly string[]>> = {
  search_console_indexing: ["gsc_indexing:", "gsc_click_drop:"],
  budget_waste: ["google_ads:", "google_ads_campaign_cpa_anomaly:", "google_ads_search_term:"],
  account_health: ["google_ads:", "api_error:", "google_ads_campaign_spend_no_conversion:", "google_ads_campaign_conversion_drop:"],
  conversion_tracking: ["ga4_event_stopped:", "google_ads:"],
  // Both added alongside the campaign-level Google Ads checks
  // (checks/google-ads-checks.ts) — previously unconstrained (any Claude
  // commentary in these categories passed through with no deterministic
  // backing required), now gated the same way as every other
  // evidence-requiring category.
  budget_pacing: ["google_ads_campaign_spend_anomaly:"],
  bid_cpc_anomaly: ["google_ads_campaign_cpc_anomaly:"],
  // Added alongside Search Term Intelligence — impression_share is the
  // category positive_keyword_opportunity findings use (deliberately not
  // "other": ai-analyst.test.ts uses "other" as its documented ungated
  // control category, and impression_share is otherwise unused by any
  // check, so this doesn't collide with existing test/gate assumptions).
  impression_share: ["google_ads_search_term:"],
};

// Claude findings are a strategic-commentary layer on top of deterministic
// detection, not a primary source — capped below "critical"/"high" so a
// speculative-by-nature finding can never carry the same weight in the
// Health Score as an actual deterministic detection.
const AI_MAX_SEVERITY: FindingDraft["severity"] = "medium";
const SEVERITY_RANK: Record<FindingDraft["severity"], number> = { critical: 3, high: 2, medium: 1, low: 0 };

function hasMatchingDraft(drafts: FindingDraft[], prefixes: readonly string[]): boolean {
  return drafts.some((draft) => prefixes.some((prefix) => draft.dedupeKey.startsWith(prefix)));
}

// Exported for direct testing, same rationale as the other pure decision
// functions in this package (e.g. ga4-checks.ts's severityForBaseline).
export function filterAiFindingDrafts(
  candidates: FindingDraft[],
  deterministicDraftsThisRun: FindingDraft[],
): FindingDraft[] {
  return candidates.flatMap((candidate) => {
    const blockPrefixes = AI_BLOCK_IF_SIGNAL_PRESENT[candidate.category];
    if (blockPrefixes && hasMatchingDraft(deterministicDraftsThisRun, blockPrefixes)) {
      return [];
    }

    const requiredPrefixes = AI_REQUIRE_SIGNAL_PRESENT[candidate.category];
    if (requiredPrefixes && !hasMatchingDraft(deterministicDraftsThisRun, requiredPrefixes)) {
      return [];
    }

    const severity =
      SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[AI_MAX_SEVERITY] ? AI_MAX_SEVERITY : candidate.severity;

    return [{ ...candidate, severity }];
  });
}

// Registered once per process, not per call — AgentRegistry.register()
// throws if the same agent id is registered twice.
let orchestrator: AgentOrchestrator | null = null;

function getOrchestrator(): AgentOrchestrator {
  if (orchestrator) return orchestrator;

  orchestrator = new AgentOrchestrator({
    memory: new InMemorySharedMemory(),
    permissionGrants: ["agent:invoke", "agent:discover", "task:execute"],
  });
  orchestrator.registerAgent(createGoogleMarketingAnalystAgent(synthesizeAdapter));

  return orchestrator;
}

// Called by run-check.ts in place of a direct strategist.ts call — the
// integration point that makes @bos/ai the single strategic-synthesis layer
// sitting above the deterministic checks, instead of a second parallel
// pipeline. Same input/output contract as runStrategistSynthesis: takes this
// run's deterministic FindingDraft[] (GA4 + GTM + Search Console + Google
// Ads + website + attribution), returns additional FindingDraft[] to merge
// in. Fails soft — any agent/orchestrator error (including a missing
// ANTHROPIC_API_KEY, already handled inside strategist.ts) results in an
// empty array, never an exception that would abort the whole check run.
export async function runGoogleMarketingAnalyst(
  tenantId: string,
  findings: FindingDraft[],
  callerId: string,
): Promise<FindingDraft[]> {
  try {
    const output = await getOrchestrator().invokeAgent(AGENT_ID, {
      tenantId,
      payload: { findings: findings as unknown as Array<Record<string, unknown>> },
      callerId,
    });

    const rawFindings = Array.isArray(output.result.findings) ? output.result.findings : [];

    const candidates = rawFindings.flatMap((entry) => {
      const result = findingLikeSchema.safeParse(entry);
      if (!result.success) return [];
      return [result.data as unknown as FindingDraft];
    });

    return filterAiFindingDrafts(candidates, findings);
  } catch (error) {
    console.error(
      "Google Marketing Analyst agent invocation failed — skipping strategic synthesis for this run",
      error,
    );
    return [];
  }
}
