import { z } from "zod";
import type { ToolDefinition } from "@bos/ai";
import { executeCommunication } from "../../communications";

// Thin wrapper only — the real logic (idempotency, the approved-only
// guard, the OutboundProvider adapter) already lives in and is already
// tested by packages/core/src/communications/service.ts. Registered here
// so a future agent decision cycle CAN propose "execute this already-
// approved communication" through the full orchestrator loop (POLICY
// CHECK -> ACTION -> VERIFICATION -> AUDIT, same as social.retry_facebook_only)
// — no agent currently does; see communications/README.md's "Known gap".
//
// riskLevel/category/requiresApproval/reversible are all set to the most
// conservative values even though communications/service.ts's own
// executeCommunication() already refuses to run on anything but an
// "approved" row — defense in depth, same rationale
// social.retry_facebook_only documents for its own doubled-up
// requiresApproval + reversible:false declaration.

const executeInputSchema = z.object({ communicationId: z.string().uuid() });
const executeOutputSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  provider: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  error: z.string().nullable(),
});

export function createExecuteApprovedCommunicationTool(): ToolDefinition<
  z.infer<typeof executeInputSchema>,
  z.infer<typeof executeOutputSchema>
> {
  return {
    name: "communication.execute_approved",
    description:
      "Executes one already-approved customer communication (packages/core/src/communications). Refuses to run on anything not already at status 'approved' — never sends without a prior human approval.",
    inputSchema: executeInputSchema,
    outputSchema: executeOutputSchema,
    riskLevel: "requires_approval",
    category: "customer_communication",
    requiresApproval: true,
    reversible: false,
    allowedAgents: ["operations"],
    getIdempotencyKey: (input) => input.communicationId,
    handler: async (input, ctx) => {
      const result = await executeCommunication(ctx.tenantId, input.communicationId);
      return {
        id: result.id,
        status: result.status,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        error: result.error,
      };
    },
    verify: async (output) => ({
      ok: output.status === "verified",
      reason: output.status === "verified" ? undefined : (output.error ?? `communication ended at status '${output.status}'`),
    }),
  };
}
