# bos-agent — BOS Agent orchestrator

**Status:** v1 — real orchestration loop, real Claude calls, real persistence, **written but never executed against production data yet** (same honest caveat every other externally-integrated module in this codebase carries — see `social-publishing/README.md`). Extends the existing `@bos/ai` scaffold (`AgentRegistry`/`AgentOrchestrator`/`SharedMemory`/`ToolRegistry`/policy engine) rather than duplicating it — see `packages/ai/README.md`.

## Purpose

A central orchestrator coordinating three domain agents — Marketing, Social, Operations — through one loop:

```
EVENT -> PERCEPTION -> DECISION -> POLICY CHECK -> ACTION -> VERIFICATION -> AUDIT
```

`orchestrator.ts`'s `runAgentCycle` is the only place all seven stages exist together. Every stage before it lives inside an agent (PERCEPTION/DECISION, delegated to `@bos/ai`'s `AgentOrchestrator.invokeAgent`) or a pure function (POLICY CHECK, `@bos/ai/policy.ts`); this file sequences them and persists the outcome after each one — same "orchestrator only sequences, each concern owns its logic" discipline `social-publishing/service.ts`'s `runWeeklySocialPost` already follows, one level up.

## Owns

Three new tables (`packages/db/src/schema/agent.ts`, migration `0019_bos_agent.sql`): `agent_runs` (one row per cycle — the AUDIT record), `agent_approvals` (the generalized `transfer-requests`-pending-approval pattern, for any agent/tool), `agent_memory` (backs `DbSharedMemory`, the production-safe replacement for `@bos/ai`'s in-memory-only `SharedMemory`).

## Exposes

`bosAgentRouter` (admin-only tRPC surface: `status`, `agents`, `tools`, `listRuns`, `getRun`, `pendingApprovals`, `approve`, `reject`, `triggerNow`); `bosAgentInngestFunctions`; `runAgentCycle`.

## The three agents — what's real, what's deliberately not autonomous yet

Each agent is a real `@bos/ai` `AgentDefinition`: real PERCEPTION (calls already-existing, already-tested read functions from `marketing`/`social-publishing`/`transfer-requests`), real DECISION (one Claude call, forced tool-use, zod-validated output, fail-soft on a missing `ANTHROPIC_API_KEY` — the exact same shape `marketing/strategist.ts`/`whatsapp/parser.ts` already use, no new LLM-calling pattern invented here).

- **Marketing Agent** (`agents/marketing-agent.ts`) — reads `getRealConversionSummary`/`getFunnelSummary`/`getConversionRates`, produces a summary/anomalies/recommendations. **Never sets a `proposedAction`** — there is no code path from this agent to any budget/campaign/price change, in this version, full stop.
- **Operations Agent** (`agents/operations-agent.ts`) — reads `listPendingApprovalTransferRequests`/`getTransferRequestFunnel`, produces follow-up/decision suggestions per pending request. **Never sets a `proposedAction`** either — it never calls `acceptTransferRequest`/`rejectTransferRequest`/`modifyPriceForTransferRequest` itself; those stay reachable only through the existing, human-operated `pending_admin_approval` -> `staffProcedure` boundary this agent's suggestions are advisory input *to*, never a bypass *of*.
- **Social Agent** (`agents/social-agent.ts`) — reads recent `social_posts` rows, may propose exactly one of two tools: `social.retry_facebook_only` (wraps `retryFacebookOnly` — **never** re-implements Meta publishing, never touches Instagram) or `social.prepare_content` (reads real served-route data, prepares a theme + image brief via the `ImageGenerator` adapter — see `image-generator.ts` — never publishes, never writes to `social_posts`).

## Policy Engine — never trusts a tool's own declaration alone

`@bos/ai/policy.ts`'s `evaluatePolicy` is a pure function with a hardcoded category deny-list/require-approval-list (`price_change`, `budget_change`, `spend`, `delete`, `booking_mutation` always require approval; `secret_change` is categorically forbidden, full stop) — independent of whatever `riskLevel`/`requiresApproval` a tool declares about itself. `social.retry_facebook_only` is additionally marked `reversible: false` (a real Facebook post cannot be un-published by this system), which alone would force approval even if its category/riskLevel were ever mis-declared — deliberate defense in depth, not redundancy by accident.

## Approval flow

Generalizes `transfer-requests`' `pending_admin_approval` -> ACCEPT/REJECT pattern into `agent_approvals`, usable by any tool. `bosAgentRouter.approve` fulfills the approval, then immediately runs `orchestrator.ts`'s `executeApprovedAction` for exactly the tool/input the original run proposed (never a re-derived action) — ACTION, VERIFICATION, and AUDIT all happen at that point, not at proposal time.

## Known gaps (deliberately out of scope this pass — see the architecture discussion this module followed)

- Domain event emission (`packages/jobs/src/events.ts`'s catalog) is only wired for `social_post.published`/`social_post.failed` (`social-publishing/service.ts`'s `runWeeklySocialPost`/`retryFacebookOnly`) — `transfer_request.created`/`transfer_request.confirmed`/`booking.confirmed`/`booking.completed`/`marketing.anomaly.detected` are all defined in the catalog but have no real producer yet. `transfer-requests/service.ts` is a large, heavily-tested (80+ cases) file; wiring real emission into it safely, plus the matching test-mock updates, is deliberately deferred rather than rushed in the same pass. `bookings/service.ts`'s `updateBooking` is a single generic patch function with no dedicated confirm/complete entry point to hook narrowly without broader, higher-risk changes.
- `ImageGenerator`'s only real provider is `NoopImageGenerator` (never calls a paid external service) — a real provider is a future addition behind the same interface.
- No dynamic, LLM-driven tool selection across the full `ToolRegistry` — each agent's Claude call is a narrow, forced, purpose-built tool schema (matching every other Claude call in this codebase), not an open-ended "pick any registered tool" dispatcher. Safer and easier to reason about for a first version; revisit only if a real need for broader dynamic dispatch appears.
- No autonomous graduation logic — every `requiresApproval`/`reversible` flag is a static, hand-set value on each tool. Promoting a specific tool to auto-approved (once it's run cleanly under approval for a while) is a deliberate, reviewed code change, never automatic.

## Hard constraints (do not relax without the founder reopening this decision)

- Never spends money, changes a budget, changes a strategic price, deletes data, cancels a booking, or touches a token/secret automatically — every one of those categories is hardcoded into the Policy Engine's deny/require-approval list, independent of any tool's own declaration.
- Never touches Instagram — no tool in this module reads or writes any `instagram*` column or calls `publishInstagramPost`.
- Never publishes to Facebook without going through `retryFacebookOnly` — no parallel Meta client, no re-implemented publish logic.
- No automated test in this module's test suite ever calls the real Anthropic API — every agent's Claude call is mocked at the module boundary (see each agent's own `.test.ts`).
