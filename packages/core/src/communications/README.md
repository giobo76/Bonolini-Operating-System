# communications

**Status:** BOS Agent Phase 3 — implemented. Approval -> Execution -> Verification for outbound customer communications, following directly from the Phase 2.5 deal layer this module reads from but never modifies.

**Owns:** `communications` (id, tenant_id, client_id, deal_id, transfer_request_id, quote_id, booking_id, channel, action, agent, correlation_id, idempotency_key, content, status, policy_decision, approved_by, approved_at, rejected_at, provider, provider_message_id, error, created_at, updated_at).

**Exposes:** `prepareQuoteOfferCommunication`, `submitCommunicationForApproval`, `approveCommunication`, `rejectCommunication`, `executeCommunication`, `getCommunication`, `findCommunicationByIdempotencyKey`, `listCommunicationsForDeal`, the `OutboundProvider` adapter interface.

**Emits:** — (no domain events this phase; a future phase may emit `communication.executed`/`communication.execution_failed` for other modules to react to).

**Listens to:** — (nothing automatic yet; see "Known gap" below).

## Why this exists

The read-only diagnosis of the 2026-09-18 production incident (and the Phase 2.5 design it led to) established two facts this module takes as given: (1) `packages/core/src/whatsapp` is receive/parse-only — no outbound send capability exists anywhere in this repository — and (2) every offer/price a customer ever received was relayed manually by the founder, outside any system. Phase 3 does not change either fact. What it adds is the machinery a real send capability could plug into later, built and fully tested now, with the one non-negotiable rule the founder set: **the BOS may prepare a communication, but must never send one to a real customer before explicit human approval.**

## State machine

```
prepared --(submitCommunicationForApproval, policy check)--> pending_approval
pending_approval --(approveCommunication)--> approved --(executeCommunication)--> executed|execution_failed
pending_approval --(rejectCommunication)--> rejected
executed --(providerMessageId confirmed)--> verified
```

`prepared` and `pending_approval` are deliberately distinct (not collapsed): `prepareQuoteOfferCommunication` only ever builds content from real data and persists it — no policy evaluation, no external effect is possible at that point. `submitCommunicationForApproval` is the separate step that runs `@bos/ai`'s Policy Engine (`evaluatePolicy`) and records its decision.

**No status here is ever set to "success" for a merely-prepared action** — `executed`/`verified` are reserved for a real, provider-confirmed send; a communication that was only prepared, or only submitted, stays at `prepared`/`pending_approval` until a human acts on it.

## Why `customer_communication` always requires approval

`@bos/ai/policy.ts`'s `evaluatePolicy` puts `customer_communication` in its hardcoded `ALWAYS_REQUIRES_APPROVAL` set — independent of anything this module declares about a specific message. This is a deliberate, conservative reading of the founder's rule ("never send a commercial offer without approval"): rather than trying to classify which prepared messages are "commercial" and which are "purely operational" (a distinction this module does not attempt, since getting it wrong in the permissive direction is the one mistake with a real customer-facing cost), **every** communication this module can prepare requires approval, full stop. This can be revisited later if the founder wants a narrower, explicitly-approved carve-out for genuinely non-commercial messages — it is not built here.

## Provider — why none is real yet

`OutboundProvider` (`provider.ts`) is the adapter interface `executeCommunication` depends on, mirroring `bos-agent/image-generator.ts`'s `ImageGenerator`/`NoopImageGenerator` pattern exactly. The only implementation that exists, `NotConfiguredOutboundProvider`, never calls any external service and never returns a fabricated success — it always reports `status: "not_configured"`, which `executeCommunication` treats as a real `execution_failed` outcome (never a silent skip, never a false "executed"). **No WhatsApp/email/SMS integration was added, modified, or wired into this module** — `packages/core/src/whatsapp` remains exactly as it was (receive/parse-only), and no Instagram/Facebook code was touched at all. A real provider is a future, separate, explicitly-reviewed addition behind this same interface — `getConfiguredOutboundProvider()` is the one place that would ever change.

## Idempotency and anti-duplication

`communications.idempotency_key` is deterministic (`quote_offer:<quoteId>`, never a counter or random value) and carries a **real `UNIQUE(tenant_id, idempotency_key)` database constraint** — stronger than `agent_approvals`' own app-level-only dedup check. `prepareQuoteOfferCommunication` uses `INSERT ... ON CONFLICT DO NOTHING` (same pattern `deals`/`transfer-requests` already use) so a retry converges on the same row instead of creating a duplicate. `executeCommunication` is separately idempotent on `status`: once a row reaches `executed`/`verified`/`execution_failed`, calling it again is a safe no-op that never calls the provider a second time — an Inngest or orchestrator retry can never double-send, never create a second quote, never create a second booking (this module never creates either).

## Relationship to the deal (Phase 2.5)

Every communication is linked to `deal_id` (and, when relevant, `transfer_request_id`/`quote_id`/`booking_id`) as a **persistent column**, never inferred from message text. `prepareQuoteOfferCommunication` verifies the quote it's given really belongs to the deal and client it's given (reading `deals`/`quotes`/`clients` only through their own public module boundaries — never touching `transfer-requests`' internals, never modifying Phase 2.5's matching logic).

## Never invents

`content.ts`'s `buildQuoteOfferContent` reads `client.fullName`/`quote.amountCents`/`quote.currency`/`quote.notes` — real, already-persisted values — and throws rather than proceed if `quote.amountCents` is `null` (a draft quote with no price yet). Nothing in this module ever marks a customer-reported payment (`deals.customerReportedPaymentNote`, Phase 2.5) as verified, confirms a booking, or invents client data — those rules are enforced by construction: this module has no function that could do any of them.

## Quote approval flow (2026-09-24)

Used by [quote-approval](../quote-approval/README.md):

- `sendMissingInfoRequest` — the one customer message that skips human approval (founder decision: fixed text, no price). Inserted directly as `approved` with that rule as its `policy_decision`, then sent via `executeCommunication`. Idempotency key `missing_info:<whatsapp_messages.id>`.
- `prepareTransferQuoteOfferCommunication` — the quote, built from `transfer_requests.final_amount_cents`, keyed `transfer_quote_offer:<transfer_request_id>` (not by quote id: `ensureQuoteForDeal` reuses one quote row per deal). Goes through the normal submit → approve (founder) → execute path.
- `executeCommunication` now claims the row atomically (`provider IS NULL`) before calling the provider, so two concurrent calls can never both send.
- The recipient is always Meta's own `from` of the client's latest inbound message, in E.164 (`whatsapp.getLastInboundWhatsappPhoneE164`). `clients.phone` is stored without `+` and would be rejected by the provider — **`prepareQuoteOfferCommunication`/`buildQuoteOfferContent` still use `clients.phone` and are not used by this flow.**
- `postWhatsappCloudApiMessage` (`whatsapp-cloud-api-client.ts`) is the single Graph API POST, shared by the provider and the founder channel.

## Known gap (deliberately out of scope this pass)

`bos-agent/tools/communication-tools.ts` registers a thin `communication.execute_approved` tool wrapper (mirroring `tools/social-tools.ts`) so a future Operations Agent decision cycle *could* propose executing an already-approved communication through the full orchestrator loop — but no agent currently does. Nothing in this codebase automatically calls `prepareQuoteOfferCommunication` when a quote is approved (no Inngest listener wired) — every call in this phase is explicit (a router, a script, a future admin UI action), same "wiring is a separate, deliberate next step" caveat `transfer-requests/README.md` already documents for its own Phase-1-era integration. No tRPC router or admin UI page was built in this pass either — the service layer is complete and fully tested; exposing it is a scoped-out follow-up.

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this and every other domain module follows.
