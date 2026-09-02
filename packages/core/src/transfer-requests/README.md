# transfer-requests — current normalized commercial request

**Status:** Foundation + pricing connection + Availability connection + admin decision + Booking Snapshot. No Google Calendar, no outbound WhatsApp, no automatic quote sending, no admin UI. See "Not built yet" below.

**Owns:** the `transfer_requests` table — the current, normalized state of an in-progress transfer request, sitting between `whatsapp_messages` (immutable per-message log) and `quotes` (official, frozen preventivo snapshot).

**Exposes:** `processTransferRequestForMessage`, `runAvailabilityForTransferRequest`, `runPricingForTransferRequest`, `processTransferRequestForMessageAndPrice` (the automatic trigger composing all three — see "Availability connection" and "Pricing connection" below), `acceptTransferRequest`, `rejectTransferRequest`, `modifyPriceForTransferRequest` (see "Admin decision" below) — the entry points that mutate `transfer_requests` — plus `getTransferRequest`, `listTransferRequestsForClient`, `computeMissingInformation`. A minimal tRPC router (`transferRequestsRouter`, in `router.ts`) exposes `get`/`accept`/`reject`/`modifyPrice` — no `list`/`listPendingApproval` yet, deliberately, until an admin UI needs one.

**Emits:** — (no Inngest events yet).

**Listens to:** — (no Inngest events — wired inline into the WhatsApp webhook pipeline, see "Integration status" below).

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
collecting_info ──(complete)──▶ ready_for_pricing ──(Availability, then pricing engine, run)──▶ pending_admin_approval
                                                                                     │
                                                                          (admin approves) ▼
                                                                                  approved ──▶ converted_to_quote [terminal]
collecting_info/ready_for_pricing ──(inactivity timeout, threshold TBD)──▶ expired
any pre-quote state ──(admin/system cancels)──▶ cancelled (see cancelled_reason)
```

`pricing_status` (`not_priced | fixed | calculated_km | manual_required`) is a **separate** field from `status`, not a workflow state — it's the pricing engine's outcome once built. No `priced` status exists: the moment pricing runs (any outcome, including `manual_required`), the request moves straight to `pending_admin_approval`.

Once `status = converted_to_quote`, all further lifecycle (sent/accepted/declined/expired) lives in `quotes.status` — never duplicated back onto `transfer_requests`.

## Completeness rule (`collecting_info → ready_for_pricing`)

Recovered from CChiefGrowthAI's `reply_builder.py:trova_informazioni_mancanti`, **with two deliberate fixes**: the original never required `pickup`/`destination` themselves to be non-null (a message with only date+passengers would have been treated as "complete") — flagged during the audit as a latent gap, not silently carried over. `computeMissingInformation()` here requires:

- `pickup`, `destination`, `passengers`, `requestedDate` — always
- `requestedTime` — always, unconditionally (**Availability milestone, founder decision**: the original CChiefGrowthAI rule, and this module's own first version, only required it for "andata" towards an airport — widened here because a real `candidateStartAt` is now needed to run Availability before pricing, and there is no acceptable default: no `"09:00"` fallback, no midnight, no invented time. See "Availability connection" below)
- `flightNumber` — additionally, if `pickup` is an airport ("ritorno" from one)

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

## Availability connection

`runAvailabilityForTransferRequest(tenantId, id, previousService)` calls the pure Availability engine ([`packages/core/src/availability`](../availability/README.md) — never duplicated here) and persists a structured, admin-explainable result onto `customerTripDurationMinutes` and `availabilityBreakdown` (jsonb, symmetric to `pricingBreakdown`). Runs **before** pricing, per the founder-confirmed sequence: WhatsApp/Email → completeness → Maps one-way → Availability → Pricing → `pending_admin_approval`. Never blocks: whatever it computes — feasible, infeasible, or `"not_verified"` because a required Maps call failed — `processTransferRequestForMessageAndPrice` always proceeds to pricing afterward.

### Two independent one-way Maps calls — never pricing's round-trip number

`customerTripDurationMinutes` (pickup → destination) is resolved via `maps-distance`'s `calculateRoute([pickup, destination])` — a plain two-waypoint, one-way call. This is **deliberately never** the same number as `pricingBreakdown.distanceLookup.durationMinutes`: that one is pricing's own round-trip total (pickup → destination → Sondrio, or the 3-leg Como-Tirano loop, via `calculateGenericRouteRoundTrip`/`calculateComoTiranoRoundTrip`) — a structurally different quantity, and reusing it here was considered and explicitly rejected during design (see the founder-facing Availability↔transfer_requests audit). The two calls run independently, for every route, regardless of whether pricing itself even needs Maps (a fixed-fare airport route never calls Maps for pricing, but still gets a `customerTripDurationMinutes` from Availability).

`relocationDurationMinutes` (relocation origin → candidate.pickup) is a second, independent one-way call, made only when a previous service is given.

### `previousService` is a caller-supplied parameter — always `null` today

Exactly like `runPricingForTransferRequest`'s `customerType`, `previousService` is never resolved inside this function. `processTransferRequestForMessageAndPrice` still passes `previousService: null` on every call — `determineRelocationOrigin(null)` then resolves to `BASE_LOCATION` (`"Sondrio"`), and every request today is evaluated as if it were the first service of the day. The Booking Snapshot milestone (see below) gave `bookings` real `pickup`/`destination`/`customerTripDurationMinutes` columns, so the data a resolver would need now exists — but wiring a live query from here into `bookings` (and updating this `null` to a real lookup) is a deliberately separate, not-yet-built next step; see "Not built yet". This is honest given the current wiring, not a shortcut: `runAvailabilityForTransferRequest` is already fully correct and tested for a real `previousService` (see `service.test.ts`'s dedicated suite).

**Never a multi-hop guess through Sondrio.** `relocationOrigin` is always exactly `previousService.destination` when one exists — never `BASE_LOCATION`, unless the previous service's destination genuinely *is* Sondrio. A previous service ending at Aprica with a next pickup in Milano relocates `Aprica → Milano` directly, never `Aprica → Sondrio → Milano`.

### `AvailabilityBreakdown` — never the pure module's field names reinvented

`feasibility` inside the persisted breakdown is Availability's own `ServiceFeasibilityResult`, serialized (`Date` fields → ISO strings for jsonb — see the codebase's own Date-serialization history for why this is never left implicit) but otherwise verbatim — `feasible`, `reason` (`"no_previous_service" | "within_operational_margin" | "insufficient_operational_margin"`), `vehicleReadyAt`, `marginMinutes`, etc. `customerTripDuration`/`relocation` (each `{status, durationMinutes, errorCode?, errorMessage?}`) and `previousServiceEndAt` are the orchestration-level context the pure module deliberately doesn't compute itself (it never calls Maps) — added one layer up here, exactly where `distanceLookup` already lives for pricing. The breakdown's own top-level `status` (`"verified" | "not_verified"`) exists because the pure module has no vocabulary for "a required Maps call failed, so no decision could even be attempted" — `isServiceFeasible` requires `relocationDurationMinutes` whenever a previous service exists and throws without it, so that case is never called with a missing/guessed number; `not_verified` is decided one layer up, before ever reaching the module.

## Pricing connection

`runPricingForTransferRequest(tenantId, id, customerType)` calls `calculatePrice()` from `packages/core/src/pricing` (never duplicated here) and persists the result onto the columns already built for exactly this purpose (`pricingStatus`, `calculatedAmountCents`, `currency`, `pricingBreakdown`). `hospitalWaiting`, `adjustments`, `baseAmountCents`, `tollAmountCents`, `serviceType`, and `customerType` have no dedicated columns — they're packed into `pricingBreakdown` (jsonb), which is free-form for exactly this reason.

`runPricingForTransferRequest`'s `customerType` remains a **caller-supplied parameter** — it does not read the client itself. That reflects a deliberate split: this function's only job is "given a request and a customerType, price it and persist the result"; resolving *what* the customerType is belongs one layer up.

### Automatic trigger: `processTransferRequestForMessageAndPrice`

`processTransferRequestForMessageAndPrice(input)` composes the full path for the common case: it calls `processTransferRequestForMessage(input)` unchanged, and — **only if that call is the one that just brought the request to `ready_for_pricing`** — runs Availability, then resolves `customerType` for real and runs pricing:

1. Calls `runAvailabilityForTransferRequest(tenantId, id, null)` — see "Availability connection" above for why `previousService` is hardcoded `null` today.
2. Reads the client via `getClient(tenantId, clientId)`, re-exported from `clients/index.ts` specifically for this (see rationale comment there — a minimal, read-only, public-boundary export, not a reach into `clients/service.ts`'s internals, per ADR 0002).
3. Derives `customerType` from `client.phone` via `determineCustomerType()` from `../pricing` — the existing implementation, not duplicated.
4. Calls `runPricingForTransferRequest(tenantId, id, customerType)` — same function described above, unchanged.

If the message leaves the request at `collecting_info` (still incomplete), no client lookup and no pricing is attempted at all — the function just returns the request as `processTransferRequestForMessage` left it. This is the recommended entry point for any caller that wants a message to price itself automatically the moment it becomes complete (e.g. a future WhatsApp webhook connection); `processTransferRequestForMessage` alone remains available for a caller that wants the plain, non-pricing behavior (e.g. an email intake path not yet ready to auto-price).

No new race condition: the partial unique index (`tenant_id, client_id` where status is `collecting_info`/`ready_for_pricing`) guarantees at most one such row per client, so no concurrent call can independently drive the same request to `ready_for_pricing`; and `runPricingForTransferRequest` is already idempotent, so even a defensive double-trigger is a safe no-op rather than a duplicate price.

**Status transition**: `status` only advances `ready_for_pricing → pending_admin_approval` when the engine returns a usable price (`fixed`/`calculated_km`). On `manual_required`, `status` stays at `ready_for_pricing` — there's nothing yet to send an admin for approval, only a reason to surface. This also keeps a `manual_required` request "open" for matching, so a corrective follow-up message can still merge into it.

**Distance is now resolved automatically when needed.** `runPricingForTransferRequest` first calls `calculatePrice()` with no `distanceKm` at all — `calculatePrice()` itself is the only authority on whether a distance is even required (fixed fares and the Como-Tirano foreign fixed fare never need one). Only when that first call reports `manualRequiredReason: "distance_not_provided"` does this connection fetch a real distance from [`packages/core/src/maps-distance`](../maps-distance/README.md) (picking the Como-Tirano 3-leg convention or the generic pickup→destination→Sondrio convention via `isComoTiranoRoute`, exported from `pricing` for exactly this) and call `calculatePrice()` a second time with it. If the distance lookup itself fails (no API key, network error, no route found), the first-pass `manual_required` result is kept as-is — no price is ever invented — and a structured `distanceLookup` object (`attempted`/`status`/`errorCode`/`errorMessage`, or the resolved `distanceKm`/`durationMinutes` on success) is packed into the persisted `pricingBreakdown` alongside the pricing engine's own fields, so an admin can see why.

`requestedServiceType` and `channel` still have no source on `transfer_requests` (no `serviceType`/`channel` columns) — every call still passes the conservative defaults (`"point_to_point"`/`"direct"`). Concretely, this connection can now produce a **real computed price for**: airport fixed fares, Como-Tirano foreign (fixed), Como-Tirano italian (3-leg distance), and generic point-to-point km (italian or foreign) — the last two conditional on `maps-distance` actually resolving a route. **Still always `manual_required`**: hourly/GetTransfer/Viator/night-holiday (no signal field exists yet to even request them — those four paths stay unreachable through this connection until `transfer_requests` gains the corresponding columns). Verified by `service.test.ts` and `maps-distance/service.test.ts`.

## Integration status

`processTransferRequestForMessageAndPrice` is wired into the live inbound WhatsApp webhook (`packages/core/src/whatsapp/webhook-handler.ts`), running inline (no Inngest event yet — see ADR 0002's cross-module rule) for every processed/duplicate message that resolved to a client. What's still deliberately **not** built: no admin notification (nothing tells an admin a request reached `pending_admin_approval` — they'd have to already know to look), no outbound message to the customer, no Google Calendar, no real `previousService` resolution (see "Availability connection" above — `bookings` has no trip-data columns yet). See the CChiefGrowthAI audit for what that old system actually did here (in short: less than you'd expect — see its own README/audit notes).

## Admin decision (ACCEPT / REJECT / MODIFY PRICE)

Three functions — `acceptTransferRequest`, `rejectTransferRequest`, `modifyPriceForTransferRequest` — are the only ones that ever move a request out of `pending_admin_approval`. None of them touch `pickup`/`destination`/`requestedDate`/`requestedTime`/`passengers`/`clientId`/`pricingBreakdown`, and **none of them ever overwrite `calculatedAmountCents`** — that column stays, forever, exactly what the pricing engine computed.

### The price split — why it exists

Recovered as a deliberate fix during the CChiefGrowthAI audit: the old bot had no such split. If the admin manually changed the price before sending it to a customer (there was no in-bot way to do this — it meant hand-editing the copy-pasted quote text), the number the bot later wrote onto a Google Calendar event was still whatever `calcola_preventivo()` had originally computed — silently wrong, with no record that a human had changed anything.

Here, that split is structural, not a convention someone has to remember:

- **`calculatedAmountCents`** — the pricing engine's output. Never written to by any admin-decision function. Always "what the engine said."
- **`finalAmountCents`** — the one column that represents what was actually approved. `null` until an admin decides. Set **atomically together with** the `pending_admin_approval → approved` transition, in the same `UPDATE`, never in a separate step — there is no window where `status = 'approved'` and `finalAmountCents` is still `null`.
- **`priceOverrideReason`** — `null` on a plain ACCEPT, always non-empty on a MODIFY_PRICE. Its nullness alone is what distinguishes "approved as computed" from "approved at an admin-chosen price" — no separate boolean column. Mirrors the `reason` input already documented for `bookings.overridePrice` in [`docs/domain/13-api-contracts.md`](../../../../docs/domain/13-api-contracts.md), not a new convention invented here.

**Binding contract for every future consumer** (Quote conversion, Booking creation, Calendar event creation — none built yet): read `finalAmountCents`, never `calculatedAmountCents`, for any request at `status ∈ {approved, converted_to_quote}`. This is the whole point of the split — do not let it erode.

### Three actions, one shared rule

All three are only ever valid starting from `status = 'pending_admin_approval'` — including MODIFY_PRICE, which does **not** stay open once the request is `approved` (a deliberate, narrower choice than a first draft of this design considered): the price-modification window closes at the very first decision, whichever of the three it was.

| Action | Result | Idempotency |
|---|---|---|
| **ACCEPT** | `status → approved`; `finalAmountCents = calculatedAmountCents` (copied, not aliased); `priceOverrideReason = null`; `adminApprovedAt`/`adminApprovedBy` set. Then ensures the booking snapshot exists (see "Booking Snapshot" below). | Calling it again on **any** already-`approved` request — via a prior ACCEPT or a prior MODIFY_PRICE — is a no-op on the transfer_request itself (same row back, `finalAmountCents`/`priceOverrideReason` never touched again) and re-attempts the booking snapshot if it's still missing. Any other non-`pending_admin_approval` status throws. |
| **REJECT** | `status → cancelled`; `cancelledReason = 'rejected_by_admin'` or `'rejected_by_admin: <note>'` (reuses the existing free-text column — no new `rejected` status value in the enum). `finalAmountCents` is left untouched (stays `null`). Never creates a booking. | Calling it again on an already-`cancelled` request whose `cancelledReason` starts with `rejected_by_admin` is a no-op. A request `cancelled` for any other reason (e.g. `superseded_by_new_request`, from the matching logic above) throws instead of being silently treated as "already rejected." |
| **MODIFY_PRICE** | `status → approved`; `finalAmountCents = <admin-supplied amountCents>` (required positive integer); `priceOverrideReason = <admin-supplied reason>` (required, non-empty); `adminApprovedAt`/`adminApprovedBy` set. Then ensures the booking snapshot exists, at the admin-chosen price. | **Not idempotent, not re-runnable once `approved`** — a second call, whether after a prior ACCEPT or a prior MODIFY_PRICE, throws. This is the one place this milestone diverges from "idempotent retries are always safe": correcting an already-approved price is explicitly out of scope here, by founder decision. If the booking snapshot itself failed to get created after a successful MODIFY_PRICE, retry via **ACCEPT** instead (idempotent for any `approved` status — see above), not by calling MODIFY_PRICE again. |

No new `transfer_request_status` enum value was added for any of this — `approved` and `cancelled` already existed (`0010_transfer_requests.sql`) but nothing had ever written them until this milestone.

## Booking Snapshot (`approved` → `bookings`)

The moment a transfer_request becomes `approved` (via either ACCEPT or MODIFY_PRICE), a confirmed `booking` row is created as a historical snapshot of the approved service — `ensureBookingForApprovedTransferRequest` in [`packages/core/src/bookings`](../bookings/README.md), reached only through that module's exported interface (`../bookings`), never by reaching into its internals (ADR 0002). `transfer-requests/service.ts` resolves everything the booking needs and hands it over as plain data — the bookings module itself never calls Maps, never interprets a timezone, never reads `transfer_requests` directly.

**Sequencing (Opzione A — no `db.transaction()` in this milestone, consistent with the rest of this module):** the `transfer_requests` update to `approved` always commits first; the booking snapshot is a second, separate, idempotent step. If that second step throws, the transfer_request is left `approved` with no booking yet — a recoverable, detectable state, not a silent inconsistency: a retried ACCEPT call (idempotent for any `approved` status) simply re-attempts it. This is a deliberate founder decision, not an oversight — see the milestone's audit history for the alternative (wrapping both steps in a transaction) that was considered and not chosen for this milestone.

**Idempotency:** `bookings.transfer_request_id` is `unique` (migration `0013`). `ensureBookingForApprovedTransferRequest` uses the same `INSERT ... ON CONFLICT DO NOTHING RETURNING *` + `SELECT`-fallback pattern this module already uses for `transfer_requests` itself (`insertNewTransferRequest`/`createOrMergeAsNewRequest`) — a transfer_request can never produce more than one booking, and retrying after a prior failure safely converges on the same row.

**`customerTripDurationMinutes` is never null on a booking.** If Availability already resolved it on the transfer_request, that value is reused as-is. If it's `null` (a Maps failure, or a malformed `requestedDate`/`requestedTime`, at Availability time — see "Availability connection" above), a fresh one-way `calculateRoute([pickup, destination])` call is made before creating the booking. If that also fails, **no booking is created** and an explicit error propagates to the admin (surfaced as `INTERNAL_SERVER_ERROR` by the router, distinguished from the `CONFLICT` used for actual invalid state transitions) — founder-confirmed rule: never a booking with a null trip duration. A value resolved this way is also written back onto the transfer_request itself, so a retry never has to call Maps twice for the same request.

**`scheduledAt` is built from `requestedDate`+`requestedTime`, explicitly interpreted in `Europe/Rome`** (native `Intl`, no new dependency — Node 20's built-in full-ICU is enough), never the server process's own timezone. This is **deliberately not** shared with `runAvailabilityForTransferRequest`'s own (naive, process-timezone) `candidateStartAt` construction above — a founder decision scoped to this milestone only, to avoid changing already-shipped, already-tested Availability arithmetic. Known, accepted gap: if the server process itself isn't running in `Europe/Rome`, the feasibility decision Availability made and this `scheduledAt` can disagree by the CET/CEST offset — not fixed in this milestone.

**`quoteId` stays `null`** on every booking created this way — a quote is never a prerequisite (`bookings.quoteId` was already nullable before this milestone). **`pickupAddress`/`destinationAddress`** are copied verbatim from the transfer_request as a historical snapshot only — never read back to change Availability's own logic, which only ever uses `pickup`/`destination`.

## Not built yet (explicitly out of scope this milestone)

A real `previousService` resolver (querying confirmed `bookings` — the schema now exists, per "Booking Snapshot" above, but the query itself isn't wired into `runAvailabilityForTransferRequest`'s call site), Google Calendar availability/event creation, outbound WhatsApp/email admin notifications, automatic quote sending, AI response generation, admin UI, `transferRequests.list`/`listPendingApproval`.
