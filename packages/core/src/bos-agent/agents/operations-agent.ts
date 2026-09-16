import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AgentDefinition } from "@bos/ai";
import { aiCategories } from "@bos/ai";
import { getTransferRequestFunnel } from "../../marketing";
import { listPendingApprovalTransferRequests } from "../../transfer-requests";
import type { AgentCycleOutput } from "../types";

// Pure advisory in this version, exactly like marketing-agent.ts: this
// handler never sets `proposedAction`, so there is no code path from this
// agent to acceptTransferRequest/rejectTransferRequest/
// modifyPriceForTransferRequest, ever — those stay reachable only through
// the existing, already-safe pending_admin_approval -> staffProcedure
// boundary (transfer-requests/router.ts), operated by a human. This agent
// only reads and summarizes; it never invents a booking, client, or price
// — every number below comes from listPendingApprovalTransferRequests/
// getTransferRequestFunnel, both already-existing, already-tested
// read-only functions.

const recommendationSchema = z.object({
  transferRequestId: z.string(),
  suggestion: z.enum(["accept", "reject", "review_price", "no_action"]),
  reasoning: z.string().min(1),
});

const decisionSchema = z.object({
  summary: z.string().min(1),
  followUpsNeeded: z.array(z.string()),
  recommendations: z.array(recommendationSchema),
});

const DECISION_TOOL = {
  name: "report_operations_assessment",
  description:
    "Report a structured assessment of pending transfer requests: a summary, any follow-ups needed, and a per-request suggestion (never executed automatically).",
  input_schema: {
    type: "object" as const,
    properties: {
      summary: { type: "string" },
      followUpsNeeded: { type: "array", items: { type: "string" } },
      recommendations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            transferRequestId: { type: "string", description: "Must be one of the ids given to you — never invented." },
            suggestion: { type: "string", enum: ["accept", "reject", "review_price", "no_action"] },
            reasoning: { type: "string" },
          },
          required: ["transferRequestId", "suggestion", "reasoning"],
        },
      },
    },
    required: ["summary", "followUpsNeeded", "recommendations"],
  },
} as const;

const SYSTEM_PROMPT =
  "You are the Operations Agent for Bonolini Transfer, a small chauffeur company. You are given real pending transfer requests (id, status, calculated price, age) and a funnel summary — never invent a booking, client, or price not present in what you're given. You never accept, reject, cancel, or re-price a request yourself — you only suggest, for a human to review and execute manually via the existing approval flow. 'review_price' means the calculated price looks worth a second look, not that you are changing it.";

async function decide(data: Record<string, unknown>): Promise<z.infer<typeof decisionSchema>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — Operations Agent producing a data-only summary for this run");
    return { summary: "ANTHROPIC_API_KEY not set — no AI synthesis available this run.", followUpsNeeded: [], recommendations: [] };
  }

  const anthropic = new Anthropic({ apiKey });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Real, already-computed data for this tenant:\n\n${JSON.stringify(data, null, 2)}\n\nReport your assessment using the report_operations_assessment tool.`,
      },
    ],
    tools: [DECISION_TOOL],
    tool_choice: { type: "tool", name: "report_operations_assessment" },
  });

  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    return { summary: "Claude returned no assessment this run.", followUpsNeeded: [], recommendations: [] };
  }

  const result = decisionSchema.safeParse(toolUse.input);
  if (!result.success) {
    return { summary: "Claude's output failed schema validation this run.", followUpsNeeded: [], recommendations: [] };
  }

  return result.data;
}

export const OPERATIONS_AGENT_ID = "operations.agent";

export const operationsAgent: AgentDefinition = {
  metadata: {
    id: OPERATIONS_AGENT_ID,
    name: "Operations Agent",
    description:
      "Reads pending transfer requests and the transfer-request funnel, and produces advisory follow-up/decision suggestions. Never accepts, rejects, cancels, or re-prices a request itself.",
    category: aiCategories.OPERATIONS,
    capabilities: ["operations", "analysis"],
    permissions: [{ permission: "agent:invoke" }, { permission: "agent:discover" }, { permission: "task:execute" }],
    version: "0.1.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  handler: async ({ tenantId }) => {
    const [pendingRequests, funnel] = await Promise.all([
      listPendingApprovalTransferRequests(tenantId),
      getTransferRequestFunnel(tenantId),
    ]);

    const perceivedRequests = pendingRequests.map((request) => ({
      id: request.id,
      status: request.status,
      calculatedAmountCents: request.calculatedAmountCents,
      pickup: request.pickup,
      destination: request.destination,
      requestedDate: request.requestedDate,
      updatedAt: request.updatedAt,
    }));

    const perception = { pendingRequests: perceivedRequests, funnel };
    const decision = await decide(perception);

    // Defensive re-validation, same discipline every other agent in this
    // module applies: drop any recommendation naming a transferRequestId
    // this perception step didn't actually see — never trust Claude's
    // output alone to have stayed within the ids it was given.
    const validIds = new Set(perceivedRequests.map((r) => r.id));
    const filteredDecision = {
      ...decision,
      recommendations: decision.recommendations.filter((r) => validIds.has(r.transferRequestId)),
    };

    const output: AgentCycleOutput = { perception, decision: filteredDecision };
    return { result: output as unknown as Record<string, unknown> };
  },
};
