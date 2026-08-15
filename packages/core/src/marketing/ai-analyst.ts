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

    return rawFindings.flatMap((entry) => {
      const result = findingLikeSchema.safeParse(entry);
      if (!result.success) return [];
      return [result.data as unknown as FindingDraft];
    });
  } catch (error) {
    console.error(
      "Google Marketing Analyst agent invocation failed — skipping strategic synthesis for this run",
      error,
    );
    return [];
  }
}
