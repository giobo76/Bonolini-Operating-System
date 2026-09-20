# deals

**Status:** Phase 2.5 of the BOS Business Intelligence + Autonomy Model — implemented. Fixes an architectural gap a real production incident exposed on 2026-09-18: one client, four `transfer_requests`, the same €300 fixed fare computed twice, and a card-payment question landing on a `transfer_request` the system had already disconnected from the offer the customer was asking about. See the read-only diagnosis this phase followed from for the full root-cause analysis.

**Owns:** `deals` (id, tenant_id, client_id, status, last_message_at, customer_reported_payment_note, customer_reported_payment_at, created_at, updated_at). Nothing else — this module never writes to `transfer_requests`/`whatsapp_messages`/`quotes`/`bookings` directly; each of those tables carries its own nullable `deal_id`, set by its own module.

**Exposes:** `createDeal`, `getDeal`, `getActiveDealsForClient`, `findMatchingDealForMessage` (the matching entry point), `reopenRecentClosedDealIfMatching`, `closeDeal`, `advanceDealStatus`, `touchDealLastMessageAt`, `looksLikeCustomerReportedPayment`, `recordCustomerReportedPayment`.

**Emits:** — (no domain events this phase; nothing downstream reacts to a deal's status yet).

**Listens to:** — (nothing; `transfer-requests/service.ts` calls this module's functions directly, service-to-service, the same pattern `bos-agent`'s orchestrator already uses for its own sub-modules).

## Why this exists

`transfer_requests` (see its own README) is deliberately scoped to "one row per in-progress request **attempt**" — the moment a request is priced (`pending_admin_approval`) or approved, it becomes invisible to the matching that decides whether a new WhatsApp message continues an existing request (`OPEN_FOR_MATCHING = ["collecting_info", "ready_for_pricing"]`, unchanged by this phase). That's the correct behavior for "should this specific attempt still accept edits" — an admin is already reviewing it — but it left nothing persistent representing "the negotiation as a whole." A message arriving after an offer had nowhere to attach to and silently spawned a new, disconnected `transfer_request` instead.

`deals` is that persistent envelope. A deal can contain more than one `transfer_request` attempt (a corrected route before any price exists, a genuinely new trip after the first one is done) — the deal is what a WhatsApp conversation actually maps to; a `transfer_request` is one specific attempt inside it.

## State machine

```
open --(priced)--> quoted --(booking created)--> confirmed --(explicit closeDeal)--> completed
  \                    \                              \
   \--(explicit closeDeal, any active state)-----------+--> cancelled --(reopenRecentClosedDealIfMatching)--> open
```

`open`, `quoted`, and `confirmed` are all **active** for matching (`ACTIVE_DEAL_STATUSES`) — a customer can ask about payment, method, or timing right up through a confirmed booking, and the message must still land on the same deal. `completed`/`cancelled` are not, except the one deliberate exception below.

`advanceDealStatus` is forward-only (`DEAL_STATUS_RANK`) — called from `transfer-requests/service.ts` when a transfer_request under a deal reaches `pending_admin_approval` (→ `quoted`) or gets a booking (→ `confirmed`); it never regresses a deal that's already further along. `closeDeal` is the only path to `completed`/`cancelled`, always an explicit call — nothing in this phase calls it automatically (no notifications/billing listener exists yet; see the phase's own explicit exclusions).

## Matching algorithm

`findMatchingDealForMessage(tenantId, clientId, candidate)` — `candidate` is just `{ pickup?, destination?, date? }`, the minimum this module needs, never the full extracted-message shape (that stays `transfer-requests`' own concern per ADR 0002). Priority order:

1. **The client's one active deal** — if exactly one `open`/`quoted`/`confirmed` deal exists, it's the answer. No further checks.
2. **Disambiguation among several active deals** (rule E/F: a client can legitimately have two genuinely different trips in flight at once) — scored by how strongly `candidate` matches each deal's current `transfer_request` (pickup/destination/date, each worth one point), tie broken by `last_message_at` (most recently touched deal wins the tie). Deliberately never uses the message's free-text `intent` as a matching signal — a deterministic field comparison is always preferred when one is available (the founder's own rule 4).
3. **A recently-cancelled deal worth reopening** (`reopenRecentClosedDealIfMatching`) — only when no active deal exists, only `cancelled` (never `completed` — a completed deal already had a real, fulfilled booking; see "Anti-duplication" below), inside a 72-hour window, with a strong pickup+destination match, and with **no booking ever recorded against it**.
4. **A brand new deal** — nothing above matched; `createDeal` opens one at `status: "open"`.

The one thing this module deliberately never reads: `whatsapp_messages.transfer_request_id`/`deal_id` idempotency (is this exact message already linked to something). That check happens one layer up, in `transfer-requests/service.ts`, before this module is ever called — this module has no reason to know about `whatsapp_messages` at all.

## Anti-duplication

No DB-level `UNIQUE` constraint on `(client_id, pickup, destination, date)` — those fields live on `transfer_requests`, not on `deals` itself, and are frequently incomplete early in a negotiation; a rigid constraint would reject legitimate rows. Dedup is entirely an application-level decision inside the matching algorithm above. If two active deals for the same client ever end up with the same strong pickup+destination+date combination (should be rare, given step 1/2 above), they are **never silently merged** — `disambiguateActiveDeals` picks one deterministically for this message, the other stays a separate deal untouched, and a future phase can add an explicit audit/warning surface for a human to review such a case (not built here — no notifications module exists yet).

`reopenRecentClosedDealIfMatching` restricting to `cancelled` (never `completed`) plus the explicit `bookings` check is the second half of this: a completed deal or one with a real booking is never silently resumed by a later, unrelated message that happens to mention the same route.

## Payments

`customerReportedPaymentNote`/`customerReportedPaymentAt` record **only** that a customer's message claimed a payment (`looksLikeCustomerReportedPayment` — a deterministic check against the WhatsApp parser's own already-extracted `intent` label, never a new AI call, never a raw-text keyword scan). This is explicitly **not** a payment or billing system: nothing here, or anywhere in `transfer-requests`/`bookings`, ever reads this field to set `paid`, `payment_verified`, or any booking/deal status. It exists purely as a note for a human to reconcile manually — the same manual process that already exists today, just no longer silently lost on an orphaned `transfer_request`. A real payments/billing module (Stripe reconciliation, invoicing) is explicitly out of scope for this phase; see the phase's own exclusions.

## Quotes

`transfer_requests.quote_id` existed in the schema since the original Transfer Request migration but no code ever set it — `quotes` had no connection to the request/pricing flow at all. This phase wires it: when `acceptTransferRequest`/`modifyPriceForTransferRequest` (`transfer-requests/service.ts`) approves a request that belongs to a deal, it reuses an existing `quotes` row for that deal if one exists, or creates one (`amountCents = finalAmountCents`, `dealId` set) otherwise, and sets `transfer_requests.quote_id` to point at it. This is bookkeeping only — **no message is sent to the customer**, and `quotes.status = "sent"` here carries the exact same meaning it already does for a quote the founder types into the admin UI by hand (`apps/transfer-admin/app/customers/[id]/actions.ts` — that form has always set `status: "sent"` at creation time too): "this quote now exists as a funnel-tracked offer," never "a message was transmitted." This codebase has no outbound WhatsApp capability of any kind, in this module or anywhere else.

## Module boundary (ADR 0002)

This module never imports from `transfer-requests`, `whatsapp`, `quotes`, or `bookings` — `transfer-requests` imports **from** `deals`, so the reverse would be circular. Where this module's own matching logic needs to read `transfer_requests` (disambiguation, reopen eligibility) or `bookings` (the reopen safety check), it queries those tables directly via `@bos/db`, never through the other modules' own service functions — consistent with how `transfer-requests` itself already reads `clients`/`bookings` tables directly in several places.
