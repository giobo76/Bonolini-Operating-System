import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { FindingDraft } from "./rule-types";
import { findingCategorySchema, findingNatureSchema, findingSeveritySchema } from "./schema";

// Requires ANTHROPIC_API_KEY for the *running BOS server* — separate from
// whatever authenticates Claude Code in this development session. This is
// a production app calling the Claude API on its own, server-side.

const claudeFindingSchema = z.object({
  category: findingCategorySchema,
  nature: findingNatureSchema,
  severity: findingSeveritySchema,
  confidenceScore: z.number().int().min(0).max(100),
  title: z.string().min(1),
  observation: z.string().min(1),
  rootCause: z.string().optional(),
  businessImpact: z.string().min(1),
  recommendedActions: z.array(z.string()),
  requiresApproval: z.boolean(),
  expectedBenefit: z.string().optional(),
});

const FINDING_TOOL = {
  name: "report_findings",
  description:
    "Report additional strategic marketing findings beyond the deterministic checks already run. Call with an empty findings array if there's genuinely nothing to add.",
  input_schema: {
    type: "object" as const,
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: findingCategorySchema.options },
            nature: { type: "string", enum: findingNatureSchema.options },
            severity: { type: "string", enum: findingSeveritySchema.options },
            confidenceScore: { type: "number", description: "0-100" },
            title: { type: "string" },
            observation: { type: "string" },
            rootCause: { type: "string" },
            businessImpact: { type: "string" },
            recommendedActions: { type: "array", items: { type: "string" } },
            requiresApproval: {
              type: "boolean",
              description: "true only if acting on this would be a budget/campaign/bid/keyword change",
            },
            expectedBenefit: { type: "string" },
          },
          required: [
            "category",
            "nature",
            "severity",
            "confidenceScore",
            "title",
            "observation",
            "businessImpact",
            "recommendedActions",
            "requiresApproval",
          ],
        },
      },
    },
    required: ["findings"],
  },
} as const;

const SYSTEM_PROMPT =
  "You are a senior Google Ads strategist, CRO specialist, GA4 analyst, and technical SEO consultant reviewing a small chauffeur business's (Bonolini Transfer) marketing account. You've been given the technical findings already detected automatically. Add any additional strategic findings a senior consultant would notice — patterns across the technical findings, likely root causes needing judgment, prioritization. Never recommend that budgets, campaigns, bids, or keywords be changed automatically — you are strictly advisory; every recommendation is for the business owner to review and execute manually. Mark requiresApproval true for any finding whose recommended action would involve spending or revenue.";

export async function runStrategistSynthesis(
  deterministicFindings: FindingDraft[],
): Promise<FindingDraft[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — skipping strategist synthesis for this audit");
    return [];
  }

  const anthropic = new Anthropic({ apiKey });

  const briefing = deterministicFindings.map((f) => ({
    category: f.category,
    severity: f.severity,
    title: f.title,
    observation: f.observation,
  }));

  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Today's automatically-detected technical findings:\n\n${JSON.stringify(briefing, null, 2)}\n\nReview these and report any additional strategic findings using the report_findings tool.`,
      },
    ],
    tools: [FINDING_TOOL],
    tool_choice: { type: "tool", name: "report_findings" },
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return [];

  const raw = (toolUse.input as { findings?: unknown[] }).findings ?? [];

  return raw.flatMap((entry) => {
    const result = claudeFindingSchema.safeParse(entry);
    if (!result.success) return [];
    return [
      {
        ...result.data,
        financialImpact: undefined,
        // Deliberately category-scoped, not title-scoped. Claude regenerates
        // fresh wording every run even when restating the same underlying
        // topic (e.g. "assess phone/WhatsApp attribution"), so embedding the
        // title here — as this used to do — meant the dedupeKey was almost
        // never stable across invocations: run-check.ts's dedup match
        // (category:dedupeKey) would miss, and a new row got created every
        // time instead of the existing one being refreshed. One AI
        // commentary slot per category is also exactly what the product
        // wants: a single representative strategic finding per topic, not
        // an accumulating pile of near-duplicates.
        dedupeKey: `claude:${result.data.category}`,
      },
    ];
  });
}
