# transfer-requests — current normalized commercial request

**Status:** Foundation only (persistence + matching/merge logic). No pricing engine, no Google Maps, no Calendar, no outbound WhatsApp, no automatic quote sending, no booking automation, no UI, no router. See "Not built yet" below.

**Owns:** the `transfer_requests` table — the current, normalized state of an in-progress transfer request, sitting between `whatsapp_messages` (immutable per-message log) and `quotes` (official, frozen preventivo snapshot).

**Exposes:** `processTransferRequestForMessage`, `runPricingForTransferRequest`, `processTransferRequestForMessageAndPrice` (the automatic trigger composing the two — see "Pricing connection" below) — the entry points that mutate `transfer_requests` — plus `getTransferRequest`, `listTransferRequestsForClient`, `computeMissingInformation`.

**Emits:** — (no Inngest events yet).

**Listens to:** — (not wired into the webhook pipeline yet — see "Integration is a separate step" below).

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this and every other domain module follows.

## Responsibility split (approved architecture)

```
whatsapp_messages   immutable message history
transfer_requests   current normalized commercial request   ← this module
quotes              official quote snapshot
bookings            confirmed/completed service
```

`whatsapp_messages.parsed` is never modified by this module. `transfer_requests` never duplicates the trip data into `quotes` until the request is actually promoted (Section "Quote transition", not built yet).

## Lifecycle

```
collecting_info ──(complete)──▶ ready_for_pricing ──(pricing engine runs)──▶ pending_admin_approval
                                                                                     │
                                                                          (admin approves) ▼
                                                                                  approved ──▶ converted_to_quote [terminal]
collecting_info/ready_for_pricing ──(inactivity timeout, threshold TBD)──▶ expired
any pre-quote state ──(admin/system cancels)──▶ cancelled (see cancelled_reason)
```

`pricing_status` (`not_priced | fixed | calculated_km | manual_required`) is a **separate** field from `status`, not a workflow state — it's the pricing engine's outcome once built. No `priced` status exists: the moment pricing runs (any outcome, including `manual_required`), the request moves straight to `pending_admin_approval`.

Once `status = converted_to_quote`, all further lifecycle (sent/accepted/declined/expired) lives in `quotes.status` — never duplicated back onto `transfer_requests`.

## Completeness rule (`collecting_info → ready_for_pricing`)

Recovered from CChiefGrowthAI's `reply_builder.py:trova_informazioni_mancanti`, **with one deliberate fix**: the original never required `pickup`/`destination` themselves to be non-null (a message with only date+passengers would have been treated as "complete"). This was flagged during the audit as a latent gap, not silently carried over — `computeMissingInformation()` here requires:

- `pickup`, `destination`, `passengers`, `requestedDate` — always
- `requestedTime` — additionally, if `destination` is an airport
- `flightNumber` — additionally, if `pickup` is an airport

Airport keywords (`malpensa, mxp, linate, orio al serio, orio, bgy`) are recovered verbatim from `reply_builder.py:AEROPORTI` — not invented.

## Matching (which request a new message belongs to)

1. First message from a client (no open request) → new `transfer_request`.
2. An open request exists (`collecting_info` or `ready_for_pricing` only — see "Founder decisions" below) → merge.
3. Merge = last-non-null-wins per field; a null/absent field in the new message never erases a value already known.
4. Both `pickup` **and** `destination` present in the new message **and** both differ from what's on file → treated as a different trip: the old request is cancelled (`cancelled_reason = 'superseded_by_new_request'`) and a new one is created. A single-field change (e.g. only `destination` changes) is a correction, not a new trip — it merges.
5. `pending_admin_approval`/`approved` requests are never merge targets — a human is already reviewing them. Any new message while one of these is the client's only request simply starts a fresh `collecting_info` request; the locked one is never touched or cancelled automatically.
6. `converted_to_quote` (and `cancelled`/`expired`) requests are never "open" — a new message after promotion always starts a new request.
7. Quote confirmation (recognizing "sì"/"confermo" etc. against an already-sent quote) is **explicitly out of scope for this milestone** — not implemented here.

### Founder decisions (confirmed)

The first draft of the approved spec's unique partial index was written as `WHERE status IN ('collecting_info','ready_for_pricing','pending_admin_approval','approved')`. Implementing it literally would have been **incompatible** with matching rule 5 above: that rule requires a brand-new `collecting_info` request to be insertable *while* an existing `pending_admin_approval`/`approved` request for the same client is left untouched and still counts as one of those four statuses — which would immediately violate a 4-status unique constraint the first time it happened. This was raised during implementation, not silently resolved, and the founder confirmed the following:

- **Decision A**: the unique index (and the matching search) cover only `('collecting_info', 'ready_for_pricing')`. `pending_admin_approval`/`approved` requests are excluded from both — they're "locked" for matching purposes, and a client can legitimately have one locked request plus one fresh `collecting_info` request coexisting. A request in `pending_admin_approval`/`approved` never blocks a new one from opening.
- **Decision B**: on a full pickup+destination conflict against an open (`collecting_info`/`ready_for_pricing`) request, the old request is marked `cancelled` with `cancelled_reason = 'superseded_by_new_request'`, and a new request is created/merged per the matching logic already implemented (unchanged from the original design).
- **Decision C**: `pickup` and `destination` are required for `ready_for_pricing` — the gap in CChiefGrowthAI's original completeness check is not replicated.
- **Decision D**: no tRPC router, no UI, in this phase — the module stays backend/domain-only.
- **Decision E**: `processTransferRequestForMessage` stays disconnected from the live WhatsApp webhook pipeline until an explicit, separate integration approval.

All five match what was already implemented — no code changes were required to apply them, only this confirmation.

## Idempotency

Reuses the existing boundary — `whatsapp_messages (tenant_id, whatsapp_message_id)` — rather than building a new one. `processTransferRequestForMessage` assumes it's only called for a message already recognized as new by that constraint, and additionally guards itself: if the given `whatsapp_messages.id` already has a `transfer_request_id` set, it returns that request unchanged instead of merging or creating again.

## Pricing connection

`runPricingForTransferRequest(tenantId, id, customerType)` calls `calculatePrice()` from `packages/core/src/pricing` (never duplicated here) and persists the result onto the columns already built for exactly this purpose (`pricingStatus`, `calculatedAmountCents`, `currency`, `pricingBreakdown`). `hospitalWaiting`, `adjustments`, `baseAmountCents`, `tollAmountCents`, `serviceType`, and `customerType` have no dedicated columns — they're packed into `pricingBreakdown` (jsonb), which is free-form for exactly this reason.

`runPricingForTransferRequest`'s `customerType` remains a **caller-supplied parameter** — it does not read the client itself. That reflects a deliberate split: this function's only job is "given a request and a customerType, price it and persist the result"; resolving *what* the customerType is belongs one layer up.

### Automatic trigger: `processTransferRequestForMessageAndPrice`

`processTransferRequestForMessageAndPrice(input)` composes the full path for the common case: it calls `processTransferRequestForMessage(input)` unchanged, and — **only if that call is the one that just brought the request to `ready_for_pricing`** — resolves `customerType` for real and runs pricing automatically:

1. Reads the client via `getClient(tenantId, clientId)`, now re-exported from `clients/index.ts` specifically for this (see rationale comment there — a minimal, read-only, public-boundary export, not a reach into `clients/service.ts`'s internals, per ADR 0002).
2. Derives `customerType` from `client.phone` via `determineCustomerType()` from `../pricing` — the existing implementation, not duplicated.
3. Calls `runPricingForTransferRequest(tenantId, id, customerType)` — same function described above, unchanged.

If the message leaves the request at `collecting_info` (still incomplete), no client lookup and no pricing is attempted at all — the function just returns the request as `processTransferRequestForMessage` left it. This is the recommended entry point for any caller that wants a message to price itself automatically the moment it becomes complete (e.g. a future WhatsApp webhook connection); `processTransferRequestForMessage` alone remains available for a caller that wants the plain, non-pricing behavior (e.g. an email intake path not yet ready to auto-price).

No new race condition: the partial unique index (`tenant_id, client_id` where status is `collecting_info`/`ready_for_pricing`) guarantees at most one such row per client, so no concurrent call can independently drive the same request to `ready_for_pricing`; and `runPricingForTransferRequest` is already idempotent, so even a defensive double-trigger is a safe no-op rather than a duplicate price.

**Status transition**: `status` only advances `ready_for_pricing → pending_admin_approval` when the engine returns a usable price (`fixed`/`calculated_km`). On `manual_required`, `status` stays at `ready_for_pricing` — there's nothing yet to send an admin for approval, only a reason to surface. This also keeps a `manual_required` request "open" for matching, so a corrective follow-up message can still merge into it.

**Known, expected limitation today**: `distanceKm`, `requestedServiceType`, and `channel` have no source on `transfer_requests` (no Maps integration, no `serviceType`/`channel` columns) — every call passes the conservative defaults (`undefined`/`"point_to_point"`/`"direct"`). Concretely, this connection can produce a **real computed price today only for**: airport fixed fares (Linate/Orio/city, Malpensa) and Como-Tirano foreign (360€ fixed) — none of these need a distance. **Every other case always resolves to `manual_required`**: generic point-to-point km (italian or foreign), Como-Tirano italian (needs the 3-leg distance), and hourly/GetTransfer/Viator/night-holiday (no signal field exists yet to even request them — `runPricingForTransferRequest` always passes `"point_to_point"`/`"direct"`/`false`, so those four paths are unreachable through this connection until `transfer_requests` gains the corresponding columns). Not a bug — the honest current state, verified by `service.test.ts`.

## Integration is a separate, deliberate next step

This milestone builds `transfer_requests` (and its automatic pricing trigger, `processTransferRequestForMessageAndPrice`) as a complete, tested, standalone unit. `packages/core/src/whatsapp/service.ts` and the webhook route are **not modified** — neither `processTransferRequestForMessage` nor `processTransferRequestForMessageAndPrice` is called from the live inbound-message pipeline yet. Wiring it in (mapping `ParsedWhatsappMessage` → `TransferRequestExtractedFields`, deciding whether it runs inline or via an Inngest event per ADR 0002's cross-module rule, and deciding what happens with a `pending_admin_approval` result — e.g. notifying an admin, which touches the `notifications` module) is left for explicit approval, since it touches the already-live, already-fixed-once WhatsApp production path.

## Not built yet (explicitly out of scope this milestone)

Pricing engine, Google Maps distance/duration, Google Calendar availability, outbound WhatsApp, automatic quote sending, booking automation, AI response generation, CChiefGrowthAI pricing-rule migration, admin UI, tRPC router.
