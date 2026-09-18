import { inngest } from "@bos/jobs";
import { getDb, tenants } from "@bos/db";
import { runAgentCycle, type RunAgentCycleInput } from "./orchestrator";
import { captureException, log } from "../observability";

async function listAllTenantIds(): Promise<string[]> {
  const db = getDb();
  const rows = await db.select({ id: tenants.id }).from(tenants);
  return rows.map((r) => r.id);
}

// Same per-tenant step.run() discipline as social-publishing/calendar/
// marketing's own crons — a retry only re-runs the tenant that actually
// failed. Each agentCycle run is its own audit row regardless (see
// orchestrator.ts's createRun), so re-executing an already-succeeded
// tenant on a genuine retry produces a second, harmless advisory run —
// "idempotent" here means "never duplicates a real-world effect," which
// holds because every mutating path (currently only
// social.retry_facebook_only) is approval-gated, never auto-executed by
// this cron itself.
function makeDailyCheck(
  id: string,
  agentName: RunAgentCycleInput["agentName"],
) {
  return inngest.createFunction({ id }, { cron: "TZ=Europe/Rome 0 8 * * *" }, async ({ step }) => {
    log(`bos_agent.${agentName}.cron.start`);
    const tenantIds = await step.run("list-tenants", listAllTenantIds);
    const results: Array<{ tenantId: string; ok: boolean }> = [];

    for (const tenantId of tenantIds) {
      try {
        await step.run(`${id}-${tenantId}`, () =>
          runAgentCycle({ tenantId, callerId: "system", agentName, trigger: "cron" }),
        );
        results.push({ tenantId, ok: true });
      } catch (error) {
        captureException(error, `bos_agent.${agentName}.cron.tenant_failed`, { tenantId });
        results.push({ tenantId, ok: false });
      }
    }

    return results;
  });
}

// Morning check, before the social-publishing cron (Monday 09:00 Europe/
// Rome) and independent of it — this never calls runWeeklySocialPost or
// social-publishing's own cron, only the Social Agent's own advisory
// review (see agents/social-agent.ts).
export const bosAgentDailyMarketingCheck = makeDailyCheck("bos-agent-daily-marketing-check", "marketing");
export const bosAgentDailyOperationsCheck = makeDailyCheck("bos-agent-daily-operations-check", "operations");
export const bosAgentDailySocialCheck = makeDailyCheck("bos-agent-daily-social-check", "social");

// ── Event-driven runs ────────────────────────────────────────────────────
// V2: reacting to real domain events (packages/jobs/src/events.ts), not
// only cron. Loop-prevention reasoning, written down rather than
// implemented as extra guard code, because the real loop-breaker already
// exists structurally: the only mutating tool any agent can propose
// (social.retry_facebook_only) is requires_approval — its execution only
// ever happens from a human clicking "Approve" in the admin UI
// (router.ts's approve -> orchestrator.ts's approveAndExecute), never
// automatically from inside an event handler. So even though
// retryFacebookOnly's own execution re-emits social_post.published/failed
// (see social-publishing/service.ts), and bosAgentOnSocialPostFailed below
// listens for exactly that event, the chain always stops at "a new pending
// approval was created" — it can never auto-execute itself into a second
// event. Idempotency: Inngest's own step.run() memoizes each step within
// one delivery/retry of the same event; the orchestrator's own
// idempotencyKey-based approval dedup (see orchestrator.ts) is the second,
// independent layer that also covers two *separate* event deliveries
// proposing the same underlying action (e.g. two failures of the same
// post).

async function runEventDrivenCycle(
  agentName: RunAgentCycleInput["agentName"],
  eventType: string,
  tenantId: string,
  correlationId: string,
  payload: Record<string, unknown>,
) {
  try {
    return await runAgentCycle({ tenantId, callerId: "system", agentName, trigger: "event", eventType, correlationId, payload });
  } catch (error) {
    captureException(error, `bos_agent.${agentName}.event.failed`, { tenantId, eventType, correlationId });
    throw error;
  }
}

// Never calls retryFacebookOnly or runWeeklySocialPost directly, never
// touches Instagram — only the Social Agent's own advisory review, exactly
// like the cron above, just triggered sooner by the real failure instead
// of waiting for the next morning's check.
export const bosAgentOnSocialPostFailed = inngest.createFunction(
  { id: "bos-agent-on-social-post-failed" },
  { event: "social_post.failed" },
  async ({ event, step }) => {
    const { tenantId, postId } = event.data as { tenantId: string; postId: string };
    return step.run("run-social-agent", () =>
      runEventDrivenCycle("social", "social_post.failed", tenantId, postId, { postId }),
    );
  },
);

// Never calls acceptTransferRequest/rejectTransferRequest/
// modifyPriceForTransferRequest — only the Operations Agent's own advisory
// review of this one specific request (see context-builder.ts, which
// resolves it from transferRequestId).
export const bosAgentOnTransferRequestCreated = inngest.createFunction(
  { id: "bos-agent-on-transfer-request-created" },
  { event: "transfer_request.created" },
  async ({ event, step }) => {
    const { tenantId, transferRequestId } = event.data as { tenantId: string; transferRequestId: string };
    return step.run("run-operations-agent", () =>
      runEventDrivenCycle("operations", "transfer_request.created", tenantId, transferRequestId, { transferRequestId }),
    );
  },
);

export const bosAgentOnTransferRequestConfirmed = inngest.createFunction(
  { id: "bos-agent-on-transfer-request-confirmed" },
  { event: "transfer_request.confirmed" },
  async ({ event, step }) => {
    const { tenantId, transferRequestId } = event.data as { tenantId: string; transferRequestId: string };
    return step.run("run-operations-agent", () =>
      runEventDrivenCycle("operations", "transfer_request.confirmed", tenantId, transferRequestId, { transferRequestId }),
    );
  },
);

// Never calls updateBooking/createBooking or any other bookings mutation —
// only the Operations Agent's own advisory review, exactly like the
// transfer_request listeners above. context-builder.ts has no special case
// for `bookingId` (only `transferRequestId`), so this run's perception is
// the agent's normal generic one (pending transfer requests + funnel) plus
// recent unscoped memory — the event's only job here is to wake the agent
// sooner than the next daily cron, not to hand it booking-specific detail.
export const bosAgentOnBookingConfirmed = inngest.createFunction(
  { id: "bos-agent-on-booking-confirmed" },
  { event: "booking.confirmed" },
  async ({ event, step }) => {
    const { tenantId, bookingId } = event.data as { tenantId: string; bookingId: string };
    return step.run("run-operations-agent", () =>
      runEventDrivenCycle("operations", "booking.confirmed", tenantId, bookingId, { bookingId }),
    );
  },
);

export const bosAgentOnBookingCompleted = inngest.createFunction(
  { id: "bos-agent-on-booking-completed" },
  { event: "booking.completed" },
  async ({ event, step }) => {
    const { tenantId, bookingId } = event.data as { tenantId: string; bookingId: string };
    return step.run("run-operations-agent", () =>
      runEventDrivenCycle("operations", "booking.completed", tenantId, bookingId, { bookingId }),
    );
  },
);

export const bosAgentInngestFunctions = [
  bosAgentDailyMarketingCheck,
  bosAgentDailyOperationsCheck,
  bosAgentDailySocialCheck,
  bosAgentOnSocialPostFailed,
  bosAgentOnTransferRequestCreated,
  bosAgentOnTransferRequestConfirmed,
  bosAgentOnBookingConfirmed,
  bosAgentOnBookingCompleted,
];
