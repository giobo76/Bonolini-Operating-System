import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, transferRequests, whatsappMessages, assertOne, type TransferRequest } from "@bos/db";
import { inngest, emitDomainEvent } from "@bos/jobs";
import {
  calculatePrice,
  computeDefaultDepositCents,
  determineCustomerType,
  isComoTiranoRoute,
  isValidDeposit,
  customerPaysDeposit,
  resolvePricingRates,
  type CustomerType,
} from "../pricing";
import { calculateGenericRouteRoundTrip, calculateComoTiranoRoundTrip, calculateRoute } from "../maps-distance";
import {
  determineRelocationOrigin,
  calculateServiceEndAt,
  isServiceFeasible,
  type PreviousService,
  type CandidateService,
} from "../availability";
import { getClient } from "../clients";
import { ensureBookingForApprovedTransferRequest, type Booking } from "../bookings";
import { createQuote, getQuoteForDeal } from "../quotes";
import {
  findMatchingDealForMessage,
  createDeal,
  advanceDealStatus,
  touchDealLastMessageAt,
  looksLikeCustomerReportedPayment,
  recordCustomerReportedPayment,
} from "../deals";
import type { TransferRequestExtractedFields, AvailabilityBreakdown, SerializedServiceFeasibilityResult } from "./schema";

// ── Airport recognition ──────────────────────────────────────────────────
// Recovered verbatim from CChiefGrowthAI (reply_builder.py:AEROPORTI) during
// the read-only audit — not invented here. Deliberately not merged with
// pricing_engine.py's slightly wider PAROLE_CHIAVE_FISSE list (which also
// includes "bergamo"/"milano" as city keywords for fixed-fare matching,
// a pricing concern out of scope for this milestone) — this module only
// needs "is this an airport", for the completeness rule below.
const AIRPORT_KEYWORDS = ["malpensa", "mxp", "linate", "orio al serio", "orio", "bgy"];

function isAirport(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return AIRPORT_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function normalizeForComparison(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.trim().toLowerCase();
}

// ── Completeness rule ─────────────────────────────────────────────────────
// Recovered from CChiefGrowthAI's reply_builder.py:trova_informazioni_mancanti,
// with one deliberate addition flagged during the audit (not invented as a
// new commercial rule, just closing a gap): the original never required
// pickup/destination themselves to be non-null. Requiring them here is what
// "NON replicare la lacuna trovata nel vecchio CChiefGrowthAI" asked for.
interface CompletenessFields {
  pickup: string | null;
  destination: string | null;
  requestedDate: string | null;
  requestedTime: string | null;
  passengers: number | null;
  flightNumber: string | null;
}

export function computeMissingInformation(fields: CompletenessFields): string[] {
  const missing: string[] = [];

  if (!fields.pickup) missing.push("pickup");
  if (!fields.destination) missing.push("destination");
  if (!fields.passengers) missing.push("passengers");
  if (!fields.requestedDate) missing.push("date");
  // Founder decision (Availability milestone): requestedTime is now
  // required for EVERY route, not only "andata" towards an airport as in
  // the original CChiefGrowthAI rule. Reason: a candidate.startAt is
  // needed to run the Availability engine before pricing, and there is no
  // acceptable default (no "09:00" fallback, no midnight, no invented
  // time) — see availability's own README on never inventing a duration,
  // same discipline applied here to the start time itself.
  if (!fields.requestedTime) missing.push("time");
  // "ritorno" (from an airport) needs a flight number — same direzione
  // logic as determina_direzione().
  if (isAirport(fields.pickup) && !fields.flightNumber) missing.push("flight_number");

  return missing;
}

function toCompletenessFields(extracted: TransferRequestExtractedFields): CompletenessFields {
  return {
    pickup: extracted.pickup ?? null,
    destination: extracted.destination ?? null,
    requestedDate: extracted.date ?? null,
    requestedTime: extracted.time ?? null,
    passengers: extracted.passengers ?? null,
    flightNumber: extracted.flight ?? null,
  };
}

// Only the two "nobody has looked at this yet" statuses participate in
// matching/merge and in the DB's uniqueness guarantee (see the migration's
// comment on transfer_requests_tenant_client_open_idx for why
// pending_admin_approval/approved are deliberately excluded).
const OPEN_FOR_MATCHING = ["collecting_info", "ready_for_pricing"] as const;

// Phase 2.5 edge case fix: the two statuses that represent a REAL, still
// relevant offer a follow-up message can legitimately continue (a payment
// question, "you already quoted me") — see the continuation branch in
// processTransferRequestForMessage below. Deliberately excludes
// 'cancelled'/'expired'/'converted_to_quote': those are terminal, dead
// attempts with no live price to continue — a deal reopened by
// reopenRecentClosedDealIfMatching (deals/service.ts) always has exactly
// this shape (status flipped back to 'open', but its one and only
// transfer_request is still the old cancelled one, deliberately never
// rewritten by the reopen itself). Without this distinction, a message
// that doesn't conflict on route would silently reuse that cancelled
// attempt's stale status/price instead of starting a fresh one.
const LIVE_OFFER_STATUSES = ["pending_admin_approval", "approved"] as const;

// Fetches every request for this client (a small, bounded set over a
// client's lifetime — the tenant+client index keeps this cheap) and picks
// the open one in plain JS, rather than an OR-of-statuses WHERE clause.
// Simpler to reason about than a compound condition, and exactly as
// correct: the partial unique index already guarantees at most one
// collecting_info/ready_for_pricing row exists per client.
async function findOpenTransferRequest(tenantId: string, clientId: string): Promise<TransferRequest | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(transferRequests)
    .where(and(eq(transferRequests.tenantId, tenantId), eq(transferRequests.clientId, clientId)))
    .orderBy(desc(transferRequests.createdAt));
  return (
    rows.find((row) => OPEN_FOR_MATCHING.includes(row.status as (typeof OPEN_FOR_MATCHING)[number])) ?? null
  );
}

// Rule 5 from the approved matching spec: only a *full* route conflict
// (both pickup and destination present and both different from what's on
// file) counts — a single-field change is a correction, not a new trip.
// Only ever called against a request in OPEN_FOR_MATCHING, so no separate
// "locked state" branch is needed here (see README.md's note on why
// pending_admin_approval/approved never reach this function at all).
function hasRouteConflict(
  existing: Pick<TransferRequest, "pickup" | "destination">,
  extracted: TransferRequestExtractedFields,
): boolean {
  const pickupChanged =
    extracted.pickup !== undefined &&
    existing.pickup !== null &&
    normalizeForComparison(extracted.pickup) !== normalizeForComparison(existing.pickup);
  const destinationChanged =
    extracted.destination !== undefined &&
    existing.destination !== null &&
    normalizeForComparison(extracted.destination) !== normalizeForComparison(existing.destination);

  return pickupChanged && destinationChanged;
}

// Raw INSERT ... ON CONFLICT, same rationale and pattern as
// packages/core/src/whatsapp/service.ts's findOrCreateClientByPhone: the
// partial unique index's WHERE clause makes this inexpressible through
// Drizzle's .onConflictDoNothing() query builder, which only accepts plain
// column targets. Only plain scalars (strings/numbers/null) are
// interpolated here — never a raw JS Date object into this template (that
// was the exact root cause of the production Date-serialization bug fixed
// earlier; see service.ts's own history). missing_information (a text[])
// is deliberately set in a separate, typed .update() call right after,
// not through this raw template, to avoid needing to trust postgres.js's
// array serialization inside a hand-built SQL string for this milestone.
async function insertNewTransferRequest(
  tenantId: string,
  clientId: string,
  extracted: TransferRequestExtractedFields,
  dealId: string,
): Promise<TransferRequest | null> {
  const db = getDb();
  const missing = computeMissingInformation(toCompletenessFields(extracted));
  const status = missing.length === 0 ? "ready_for_pricing" : "collecting_info";

  const insertedRows = await db.execute<TransferRequest>(sql`
    insert into transfer_requests (
      tenant_id, client_id, deal_id, status, intent, pickup, destination,
      requested_date, requested_time, passengers, luggage,
      flight_number, train_number, hotel, language
    ) values (
      ${tenantId}, ${clientId}, ${dealId}, ${status},
      ${extracted.intent ?? null}, ${extracted.pickup ?? null}, ${extracted.destination ?? null},
      ${extracted.date ?? null}, ${extracted.time ?? null}, ${extracted.passengers ?? null}, ${extracted.luggage ?? null},
      ${extracted.flight ?? null}, ${extracted.train ?? null}, ${extracted.hotel ?? null}, ${extracted.language ?? null}
    )
    on conflict (tenant_id, client_id) where status in ('collecting_info', 'ready_for_pricing')
    do nothing
    returning *
  `);

  if (insertedRows.length === 0) return null;

  const created = assertOne(insertedRows, "insertNewTransferRequest");
  const [withMissing] = await db
    .update(transferRequests)
    .set({
      missingInformation: missing,
      children: extracted.children ?? null,
      childrenAges: extracted.childrenAges ?? null,
    })
    .where(eq(transferRequests.id, created.id))
    .returning();
  const result = withMissing ?? created;

  // Fire-and-forget, fail-soft (emitDomainEvent never throws) — for the
  // BOS Agent's Operations Agent (packages/core/src/bos-agent), the one
  // real point a transfer_request comes into existence. Never awaited
  // synchronously so a transient event-delivery problem can't slow down or
  // fail message intake.
  void emitDomainEvent(inngest, "transfer_request.created", {
    tenantId,
    transferRequestId: result.id,
    status: result.status,
  });

  return result;
}

// Wraps insertNewTransferRequest with the same race fallback as
// findOrCreateClientByPhone: if the atomic insert loses the race (another
// open request now exists for this client), merge into the winner instead
// of throwing — the outcome the caller cares about ("there is now one
// open request reflecting this message's data") is the same either way.
async function createOrMergeAsNewRequest(
  tenantId: string,
  clientId: string,
  extracted: TransferRequestExtractedFields,
  dealId: string,
): Promise<TransferRequest> {
  const created = await insertNewTransferRequest(tenantId, clientId, extracted, dealId);
  if (created) return created;

  // Race fallback (rare — see insertNewTransferRequest's own doc comment):
  // another open request now exists for this client. It may belong to a
  // *different* deal than the one this call resolved (the concurrent
  // caller could have raced on its own, separate deal resolution) — merged
  // into as-is, deal_id left untouched, same "converge on the winner"
  // philosophy findOrCreateClientByPhone already applies. This window is
  // narrow enough (two inbound messages for the same client processed by
  // genuinely concurrent invocations) that reconciling deal ownership here
  // is deliberately not attempted.
  const existing = await findOpenTransferRequest(tenantId, clientId);
  if (!existing) {
    // Unreachable in practice: a conflict on this index means a matching
    // open row exists. Guarded rather than silently swallowed, same
    // discipline as findOrCreateClientByPhone's equivalent branch.
    throw new Error("createOrMergeAsNewRequest: insert conflicted but no open request was found");
  }
  return mergeIntoTransferRequest(existing, extracted);
}

// Last-non-null-wins merge (rules 3/4 of the approved matching spec): a
// null/absent field in the new message never erases a value already known.
async function mergeIntoTransferRequest(
  existing: TransferRequest,
  extracted: TransferRequestExtractedFields,
): Promise<TransferRequest> {
  const db = getDb();

  const merged = {
    intent: extracted.intent ?? existing.intent,
    pickup: extracted.pickup ?? existing.pickup,
    destination: extracted.destination ?? existing.destination,
    requestedDate: extracted.date ?? existing.requestedDate,
    requestedTime: extracted.time ?? existing.requestedTime,
    passengers: extracted.passengers ?? existing.passengers,
    luggage: extracted.luggage ?? existing.luggage,
    children: extracted.children ?? existing.children,
    childrenAges: extracted.childrenAges ?? existing.childrenAges,
    flightNumber: extracted.flight ?? existing.flightNumber,
    trainNumber: extracted.train ?? existing.trainNumber,
    hotel: extracted.hotel ?? existing.hotel,
    language: extracted.language ?? existing.language,
  };

  const missing = computeMissingInformation(merged);
  // Monotonic: merge only ever fills gaps, never nulls a field out, so
  // completeness can only improve or stay the same — recomputing fresh
  // each time is simpler than trying to special-case "was already
  // ready_for_pricing" and gives the same result.
  const status = missing.length === 0 ? "ready_for_pricing" : "collecting_info";

  const rows = await db
    .update(transferRequests)
    .set({ ...merged, missingInformation: missing, status, updatedAt: new Date() })
    .where(eq(transferRequests.id, existing.id))
    .returning();
  return assertOne(rows, "mergeIntoTransferRequest");
}

// A full-route conflict against an OPEN (never-reviewed) request means the
// customer is very likely describing a different trip, not correcting this
// one. The old request is superseded (cancelled, not silently abandoned)
// rather than left open forever with stale data — a data-model judgment
// call flagged in README.md, not a new commercial/pricing rule.
async function cancelSuperseded(existing: TransferRequest): Promise<void> {
  const db = getDb();
  await db
    .update(transferRequests)
    .set({ status: "cancelled", cancelledReason: "superseded_by_new_request", updatedAt: new Date() })
    .where(eq(transferRequests.id, existing.id));
}

export interface TransferRequestMessageInput {
  tenantId: string;
  clientId: string;
  // The whatsapp_messages row id (not the Meta whatsapp_message_id) — used
  // both to link the message to the resulting request and as this
  // function's own idempotency guard (see below).
  whatsappMessageId: string;
  extracted: TransferRequestExtractedFields;
}

// Read-only lookup of the deal's most recent transfer_request attempt —
// "current" for matching purposes, same "most recent wins" convention
// findOpenTransferRequest itself already uses. Deliberately local to this
// module (never exported): the deals module has its own private,
// near-identical helper for its own matching decisions (disambiguation,
// reopen eligibility) — the small duplication is what avoids a circular
// module import (deals -> transfer-requests -> deals), documented on both
// sides. This one additionally never filters by status: unlike
// findOpenTransferRequest (only ever OPEN_FOR_MATCHING rows), the caller
// below needs to see a pending_admin_approval/approved/cancelled attempt
// too, to decide whether a continuation message needs a new attempt at
// all.
async function getCurrentTransferRequestForDeal(tenantId: string, dealId: string): Promise<TransferRequest | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(transferRequests)
    .where(and(eq(transferRequests.tenantId, tenantId), eq(transferRequests.dealId, dealId)))
    .orderBy(desc(transferRequests.createdAt));
  return rows[0] ?? null;
}

// The single entry point this module exposes for turning one inbound
// WhatsApp message's extracted fields into transfer_requests state.
//
// Idempotency: this function assumes it is only invoked for a message that
// whatsapp_messages' own (tenant_id, whatsapp_message_id) uniqueness has
// already recognized as new — the same discipline processInboundMessage
// already applies before calling findOrCreateClientByPhone/parsing (see
// packages/core/src/whatsapp/service.ts). It also defends itself: if this
// exact message row has already been linked to a request (e.g. called
// twice by mistake), it returns that request unchanged instead of
// re-merging or creating a second one.
//
// Phase 2.5 (BOS Business Intelligence + Autonomy Model — Deal layer):
// resolves/creates the persistent deals.Deal this message belongs to
// BEFORE any transfer_request decision — see packages/core/src/deals for
// the matching algorithm and the real production incident (2026-09-18)
// this fixes. The state machine below this point is UNCHANGED: hasRouteConflict/
// mergeIntoTransferRequest/insertNewTransferRequest still decide, exactly
// as before, what happens to a transfer_request that's still
// OPEN_FOR_MATCHING. What changed is WHICH transfer_request that logic is
// scoped to (the deal's current attempt, not a bare client-global lookup)
// and what happens when the deal's current attempt is no longer
// OPEN_FOR_MATCHING (see the two new branches below).
export async function processTransferRequestForMessage(
  input: TransferRequestMessageInput,
): Promise<TransferRequest> {
  const db = getDb();

  const [messageRow] = await db
    .select({
      transferRequestId: whatsappMessages.transferRequestId,
      rawText: whatsappMessages.rawText,
      receivedAt: whatsappMessages.receivedAt,
    })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.id, input.whatsappMessageId));

  if (messageRow?.transferRequestId) {
    const already = await getTransferRequest(input.tenantId, messageRow.transferRequestId);
    if (already) return already;
  }

  let { deal } = await findMatchingDealForMessage(input.tenantId, input.clientId, {
    pickup: input.extracted.pickup,
    destination: input.extracted.destination,
    date: input.extracted.date,
  });

  const currentTransferRequest = await getCurrentTransferRequestForDeal(input.tenantId, deal.id);

  let target: TransferRequest;

  if (!currentTransferRequest) {
    // First attempt under this deal (covers a brand new deal, and a
    // reopened one whose prior attempts — if any — never got a deal_id,
    // i.e. predate this phase).
    target = await createOrMergeAsNewRequest(input.tenantId, input.clientId, input.extracted, deal.id);
  } else if (OPEN_FOR_MATCHING.includes(currentTransferRequest.status as (typeof OPEN_FOR_MATCHING)[number])) {
    // Unchanged: the deal's current attempt hasn't been priced/reviewed
    // yet, so the existing, already-tested decision (supersede on a real
    // route conflict, merge otherwise) applies exactly as before Phase
    // 2.5 — only the source of "which transfer_request" changed (deal-scoped
    // instead of a bare client-global lookup), never the decision itself.
    if (hasRouteConflict(currentTransferRequest, input.extracted)) {
      await cancelSuperseded(currentTransferRequest);
      target = await createOrMergeAsNewRequest(input.tenantId, input.clientId, input.extracted, deal.id);
    } else {
      target = await mergeIntoTransferRequest(currentTransferRequest, input.extracted);
    }
  } else if (!LIVE_OFFER_STATUSES.includes(currentTransferRequest.status as (typeof LIVE_OFFER_STATUSES)[number])) {
    // Edge case fix: the deal's current attempt is 'cancelled'/'expired'/
    // 'converted_to_quote' — a terminal, dead attempt, never a live offer
    // to continue or reuse. This is exactly the shape a deal reopened by
    // reopenRecentClosedDealIfMatching has (deals/service.ts flips the
    // deal back to 'open' but deliberately never rewrites its old
    // transfer_request) — the customer coming back after a cancellation
    // must get a genuinely fresh attempt, never the old one's stale
    // status/price silently reused. Always a new attempt under the SAME
    // deal (never a new deal: the deal itself already correctly
    // identifies this as the same negotiation resuming) — the old
    // transfer_request is left completely untouched, staying in the
    // historical record exactly as it was.
    target = await createOrMergeAsNewRequest(input.tenantId, input.clientId, input.extracted, deal.id);
  } else if (hasRouteConflict(currentTransferRequest, input.extracted)) {
    // The deal's current attempt is a live, already-priced/approved offer,
    // and this message describes a genuinely different trip (both pickup
    // AND destination present and different — hasRouteConflict's own rule,
    // unchanged). Unlike the OPEN_FOR_MATCHING branch above (where a route
    // conflict is still just a correction of a not-yet-reviewed request,
    // same deal), an offer has already been made here — reusing this deal
    // for an unrelated route would be exactly the kind of silent merge
    // rule F/9 of the approved design forbids ("due richieste diverse
    // dello stesso cliente" must produce two deals, never one). A brand
    // new deal, with its own first attempt, is created instead.
    deal = await createDeal(input.tenantId, input.clientId);
    target = await createOrMergeAsNewRequest(input.tenantId, input.clientId, input.extracted, deal.id);
  } else {
    // THE FIX for the 2026-09-18 production incident: a continuation
    // message on an already-priced/approved transfer_request (a payment
    // question, a booking confirmation, "you already quoted me a few
    // hours ago") now attaches to the deal's existing attempt instead of
    // silently spawning a new, disconnected one. Deliberately returns the
    // attempt UNCHANGED rather than calling mergeIntoTransferRequest — that
    // function always recomputes status from missingInformation (see its
    // own doc comment — "only ever called against a request in
    // OPEN_FOR_MATCHING") and would silently regress an already-priced/
    // approved request back to ready_for_pricing/collecting_info, undoing
    // real pricing/approval work. There is nothing safe to merge here:
    // the whole point of this branch is that no new trip data arrived.
    target = currentTransferRequest;
  }

  // Phase 2.5 — customer-reported payment (never treated as verified; see
  // packages/core/src/deals/README.md's "Payments" section). Checked
  // against the parser's own already-extracted intent label, never a new
  // AI call or a raw-text keyword scan (rule 4 of the approved design).
  const receivedAt = messageRow?.receivedAt ?? new Date();
  if (messageRow?.rawText && looksLikeCustomerReportedPayment(input.extracted.intent)) {
    await recordCustomerReportedPayment(input.tenantId, deal.id, messageRow.rawText, receivedAt);
  }
  await touchDealLastMessageAt(input.tenantId, deal.id, receivedAt);

  await db
    .update(whatsappMessages)
    .set({ transferRequestId: target.id, dealId: deal.id })
    .where(eq(whatsappMessages.id, input.whatsappMessageId));

  return target;
}

export async function getTransferRequest(tenantId: string, id: string): Promise<TransferRequest | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(transferRequests)
    .where(and(eq(transferRequests.tenantId, tenantId), eq(transferRequests.id, id)));
  return row ?? null;
}

// Read-only. Added for the BOS Agent's Operations Agent (packages/core/
// src/bos-agent), which only ever reads this list to produce an advisory
// summary — it never calls accept/reject/modifyPrice itself. The
// pending_admin_approval -> decision boundary these rows sit at is
// unchanged; this is purely a new way to see it, not a new way to cross
// it. `desc(updatedAt)` surfaces the most recently priced/re-priced
// request first, since that's usually the one closest to needing a
// decision. No `.limit()` — same shape as listTransferRequestsForClient
// above; a caller needing fewer rows slices the result itself.
export async function listPendingApprovalTransferRequests(tenantId: string): Promise<TransferRequest[]> {
  const db = getDb();
  return db
    .select()
    .from(transferRequests)
    .where(and(eq(transferRequests.tenantId, tenantId), eq(transferRequests.status, "pending_admin_approval")))
    .orderBy(desc(transferRequests.updatedAt));
}

export async function listTransferRequestsForClient(tenantId: string, clientId: string): Promise<TransferRequest[]> {
  const db = getDb();
  return db
    .select()
    .from(transferRequests)
    .where(and(eq(transferRequests.tenantId, tenantId), eq(transferRequests.clientId, clientId)))
    .orderBy(desc(transferRequests.createdAt));
}

// Runs the pricing engine (packages/core/src/pricing — never duplicated
// here) against a transfer_request already at ready_for_pricing, and
// persists the result onto the columns that already exist for exactly this
// purpose (pricingStatus, calculatedAmountCents, currency, pricingBreakdown).
//
// customerType is a caller-supplied parameter, not resolved here: transfer_requests
// has no phone/customerType field of its own (only client_id), and
// packages/core/src/clients/index.ts does not export a getClient() reader
// today. Rather than add that cross-module dependency, the caller (whoever
// eventually wires this to a real trigger — not done in this milestone)
// is expected to resolve it via determineCustomerType() from ../pricing
// using whatever it already knows about the client. Keeps this connection
// strictly two-module (transfer-requests + pricing).
//
// Status transition rule (founder-confirmed): status only advances to
// pending_admin_approval when the engine returns a usable price (fixed or
// calculated_km). On manual_required, status stays at ready_for_pricing —
// there is nothing yet to send an admin for approval, only a reason to
// surface. This also keeps a manual_required request "open" for matching
// (see OPEN_FOR_MATCHING), so a corrective follow-up WhatsApp/email message
// can still merge into it normally.
//
// A no-op (returns the row unchanged) if status isn't ready_for_pricing —
// safe to call defensively, including twice on the same request.
export async function runPricingForTransferRequest(
  tenantId: string,
  id: string,
  customerType: CustomerType,
): Promise<TransferRequest> {
  const db = getDb();
  const existing = await getTransferRequest(tenantId, id);
  if (!existing) {
    throw new Error(`runPricingForTransferRequest: no transfer_request found for id ${id}`);
  }

  if (existing.status !== "ready_for_pricing") {
    return existing;
  }

  // Invariant guaranteed by computeMissingInformation before status can
  // reach ready_for_pricing — guarded rather than silently trusted, same
  // discipline as this module's other invariant checks.
  if (!existing.pickup || !existing.destination || !existing.passengers) {
    throw new Error(`runPricingForTransferRequest: transfer_request ${id} is ready_for_pricing but missing required fields`);
  }

  const pickup = existing.pickup;
  const destination = existing.destination;
  const passengers = existing.passengers;

  // requestedServiceType/channel/possibleNightOrHolidaySurcharge have no
  // source on transfer_requests today (no serviceType/channel columns) —
  // always the conservative default, which the pricing engine already
  // handles as manual_required where it matters. Not a workaround: this is
  // the honest, current state of what this connection can signal.
  const basePricingInput = {
    customerType,
    pickup,
    destination,
    passengers,
    requestedServiceType: "point_to_point" as const,
    channel: "direct" as const,
    possibleNightOrHolidaySurcharge: false,
  };

  // Phase 2 (Business Rules): resolved once per pricing attempt and reused
  // for both calculatePrice() calls below (first pass and, if needed, the
  // distance-aware second pass) — the tariff values must not differ
  // between the two calls within the same request. See
  // pricing/rates-provider.ts's own header comment for what "resolved"
  // means (business rule if effective and valid, the documented temporary
  // fallback if merely missing, or an explicit `null` — never a silently
  // invented price — if a rule exists but is genuinely invalid).
  const ratesResolution = await resolvePricingRates(tenantId);

  // First pass, no distance: calculatePrice() is the only authority on
  // whether a distance is even needed at all (fixed fares and the
  // Como-Tirano foreign fixed fare never need one) — this connection never
  // re-implements that routing/fare-matching decision itself. Only when
  // the engine's own answer is "the sole blocker is a missing distance" do
  // we go fetch one from maps-distance, then ask the engine again with it.
  let pricingResult = calculatePrice(basePricingInput, ratesResolution.rates);
  let distanceLookup: Record<string, unknown> = { attempted: false };

  if (pricingResult.manualRequiredReason === "distance_not_provided") {
    // isComoTiranoRoute is the same pure keyword check calculatePrice()
    // itself uses internally (exported from pricing specifically for this
    // — see pricing/index.ts) — picking the matching maps-distance waypoint
    // convention here never duplicates that logic, only reads its answer.
    const routeResult = isComoTiranoRoute(pickup, destination)
      ? await calculateComoTiranoRoundTrip()
      : await calculateGenericRouteRoundTrip(pickup, destination);

    if (routeResult.status === "ok" && routeResult.distanceKm !== null) {
      distanceLookup = {
        attempted: true,
        status: "ok",
        provider: routeResult.provider,
        distanceKm: routeResult.distanceKm,
        durationMinutes: routeResult.durationMinutes,
      };
      pricingResult = calculatePrice({ ...basePricingInput, distanceKm: routeResult.distanceKm }, ratesResolution.rates);
    } else {
      // Maps couldn't produce a real distance: pricingResult stays exactly
      // the first-pass manual_required result above — no price is ever
      // invented. distanceLookup below records the structured reason why,
      // for the admin, without touching the pricing engine's own typed
      // manualRequiredReason ("distance_not_provided" already covers the
      // commercial-facing "why": no distance was available).
      distanceLookup = {
        attempted: true,
        status: "error",
        errorCode: routeResult.error?.code ?? null,
        errorMessage: routeResult.error?.message ?? null,
      };
    }
  }

  const nextStatus = pricingResult.pricingStatus === "manual_required" ? existing.status : "pending_admin_approval";

  const rows = await db
    .update(transferRequests)
    .set({
      status: nextStatus,
      pricingStatus: pricingResult.pricingStatus,
      calculatedAmountCents: pricingResult.finalAmountCents,
      currency: pricingResult.currency,
      pricingBreakdown: {
        ...pricingResult.pricingBreakdown,
        serviceType: pricingResult.serviceType,
        customerType: pricingResult.customerType,
        baseAmountCents: pricingResult.baseAmountCents,
        tollAmountCents: pricingResult.tollAmountCents,
        adjustments: pricingResult.adjustments,
        hospitalWaiting: pricingResult.hospitalWaiting,
        distanceLookup,
        // Phase 2 (Business Rules) provenance: which rule/version (or
        // documented fallback) supplied each tariff value used above —
        // "quale regola ho applicato e perché", ready for a future BOS
        // workflow to surface without re-plumbing the pricing engine. Not
        // itself acted on anywhere yet this phase; purely recorded.
        pricingRuleProvenance: ratesResolution.provenance,
        pricingRulesUsedFallback: ratesResolution.usedFallback,
        pricingRulesInvalidReason: ratesResolution.invalidReason ?? null,
      },
      updatedAt: new Date(),
    })
    .where(eq(transferRequests.id, id))
    .returning();

  return assertOne(rows, "runPricingForTransferRequest");
}

function serializeFeasibilityResult(result: {
  feasible: boolean;
  reason: string;
  candidateStartAt: Date;
  candidatePickup: string;
  candidateDestination: string;
  customerTripDurationMinutes: number | null;
  vehicleRelocationDurationMinutes: number | null;
  operationalBufferMinutes: number;
  vehicleReadyAt: Date | null;
  marginMinutes: number | null;
}): SerializedServiceFeasibilityResult {
  return {
    ...result,
    candidateStartAt: result.candidateStartAt.toISOString(),
    vehicleReadyAt: result.vehicleReadyAt ? result.vehicleReadyAt.toISOString() : null,
  } as SerializedServiceFeasibilityResult;
}

// Always-safe fallback: never thrown out to the caller, always persisted
// and returned. Used whenever something prevents a real feasibility
// decision (malformed candidate start time, an unexpected error from the
// pure availability module) — the same "never invent, record why" rule
// applied to Maps failures below, just for a different failure class.
function notVerifiedBreakdown(errorMessage: string): AvailabilityBreakdown {
  return {
    status: "not_verified",
    customerTripDuration: { status: "error", durationMinutes: null, errorMessage },
    relocation: { status: "not_applicable", origin: null, durationMinutes: null },
    previousServiceEndAt: null,
    feasibility: null,
  };
}

// Runs the Availability engine (packages/core/src/availability — never
// duplicated here) against a transfer_request already at ready_for_pricing,
// and persists a structured, admin-explainable result. Deliberately never
// blocks anything: whatever this computes (feasible, infeasible, or
// "not_verified" because a required Maps call failed), the caller is
// always free to proceed to pricing/pending_admin_approval afterward — see
// README.md's "Availability" section for why this is a founder decision,
// not an oversight.
//
// previousService is a caller-supplied parameter, exactly like
// runPricingForTransferRequest's customerType — this function never
// queries `bookings` itself. As of this milestone, `bookings` has no
// pickup/destination/duration columns yet (deferred to the Booking
// Snapshot milestone), so there is no real data to query: every caller
// today passes `previousService: null` (see
// processTransferRequestForMessageAndPrice below). The parameter exists so
// this function is already correct and fully tested for the day a real
// resolver exists — swapping in a live `bookings` lookup then requires no
// change here.
//
// customerTripDuration (pickup -> destination, one-way) is always
// attempted, via maps-distance's calculateRoute([pickup, destination]) —
// a single real HTTP call, one waypoint pair, never the round-trip
// convention pricing's own distanceLookup uses (Sondrio-anchored, 2+
// legs) — that number is structurally the wrong shape for this purpose
// and is never read here. relocationDurationMinutes (previousService's
// destination -> candidate.pickup, or not attempted at all when there is
// no previous service) is a second, independent one-way call.
export async function runAvailabilityForTransferRequest(
  tenantId: string,
  id: string,
  previousService: PreviousService | null,
): Promise<TransferRequest> {
  const db = getDb();
  const existing = await getTransferRequest(tenantId, id);
  if (!existing) {
    throw new Error(`runAvailabilityForTransferRequest: no transfer_request found for id ${id}`);
  }

  if (existing.status !== "ready_for_pricing") {
    return existing;
  }

  // Invariant guaranteed by computeMissingInformation before status can
  // reach ready_for_pricing (requestedTime is now unconditionally required
  // — see its own comment there) — guarded rather than silently trusted,
  // same discipline as this module's other invariant checks.
  if (!existing.pickup || !existing.destination || !existing.requestedDate || !existing.requestedTime) {
    throw new Error(
      `runAvailabilityForTransferRequest: transfer_request ${id} is ready_for_pricing but missing pickup/destination/requestedDate/requestedTime`,
    );
  }

  const pickup = existing.pickup;
  const destination = existing.destination;
  const candidateStartAt = new Date(`${existing.requestedDate}T${existing.requestedTime}:00`);

  let availabilityBreakdown: AvailabilityBreakdown;
  let customerTripDurationMinutes: number | null = null;

  if (Number.isNaN(candidateStartAt.getTime())) {
    // Malformed requestedDate/requestedTime — never blocks pricing, and
    // never guessed into a fallback time (no "09:00", no midnight).
    availabilityBreakdown = notVerifiedBreakdown(
      `invalid requestedDate/requestedTime: '${existing.requestedDate}' '${existing.requestedTime}'`,
    );
  } else {
    const candidate: CandidateService = { startAt: candidateStartAt, pickup, destination };

    // customerTripDuration: always attempted, independent of previousService
    // and of anything pricing does or doesn't need — a fixed-fare route
    // (which pricing never sends to Maps at all) still gets this call,
    // because Availability's own job never depends on how pricing works.
    const customerTripResult = await calculateRoute([pickup, destination]);
    const customerTripDuration: AvailabilityBreakdown["customerTripDuration"] =
      customerTripResult.status === "ok" && customerTripResult.durationMinutes !== null
        ? { status: "ok", durationMinutes: customerTripResult.durationMinutes }
        : {
            status: "error",
            durationMinutes: null,
            errorCode: customerTripResult.error?.code ?? null,
            errorMessage: customerTripResult.error?.message ?? null,
          };
    if (customerTripDuration.status === "ok") {
      customerTripDurationMinutes = customerTripDuration.durationMinutes;
    }

    try {
      if (!previousService) {
        // No previous service to relocate from — determineRelocationOrigin
        // resolves to BASE_LOCATION ("Sondrio"), but isServiceFeasible
        // needs no relocation duration at all in this branch (it never
        // calls Maps itself, and neither do we here) — always feasible,
        // per the founder-confirmed rule.
        const result = isServiceFeasible({ candidate, previousService: null });
        availabilityBreakdown = {
          status: "verified",
          customerTripDuration,
          relocation: { status: "not_applicable", origin: determineRelocationOrigin(null), durationMinutes: null },
          previousServiceEndAt: null,
          feasibility: serializeFeasibilityResult(result),
        };
      } else {
        // relocationOrigin is ALWAYS previousService.destination — never
        // Sondrio, never a multi-hop guess through the base, exactly the
        // founder's explicit rule (see determineRelocationOrigin itself).
        const relocationOrigin = determineRelocationOrigin(previousService);
        const previousServiceEndAt = calculateServiceEndAt(
          previousService.startAt,
          previousService.customerTripDurationMinutes,
        );
        const relocationResult = await calculateRoute([relocationOrigin, pickup]);

        if (relocationResult.status === "ok" && relocationResult.durationMinutes !== null) {
          const result = isServiceFeasible({
            candidate,
            previousService,
            relocationDurationMinutes: relocationResult.durationMinutes,
          });
          availabilityBreakdown = {
            status: "verified",
            customerTripDuration,
            relocation: { status: "ok", origin: relocationOrigin, durationMinutes: relocationResult.durationMinutes },
            previousServiceEndAt: previousServiceEndAt.toISOString(),
            feasibility: serializeFeasibilityResult(result),
          };
        } else {
          // Relocation duration unknown: isServiceFeasible requires it
          // whenever a previous service exists (it throws otherwise, by
          // its own design) — never called with a missing/guessed number,
          // so no feasibility decision is invented here either.
          availabilityBreakdown = {
            status: "not_verified",
            customerTripDuration,
            relocation: {
              status: "error",
              origin: relocationOrigin,
              durationMinutes: null,
              errorCode: relocationResult.error?.code ?? null,
              errorMessage: relocationResult.error?.message ?? null,
            },
            previousServiceEndAt: previousServiceEndAt.toISOString(),
            feasibility: null,
          };
        }
      }
    } catch (error) {
      // Defensive: the pure availability module throws on structurally
      // invalid input (see its own guards) — should be unreachable given
      // the checks above, but a thrown error here must still never abort
      // the caller's path to pricing. Recorded, never silently swallowed.
      availabilityBreakdown = notVerifiedBreakdown(
        error instanceof Error ? error.message : "unexpected availability error",
      );
    }
  }

  const rows = await db
    .update(transferRequests)
    .set({
      customerTripDurationMinutes,
      availabilityBreakdown,
      updatedAt: new Date(),
    })
    .where(eq(transferRequests.id, id))
    .returning();

  return assertOne(rows, "runAvailabilityForTransferRequest");
}

// The automatic trigger: runs processTransferRequestForMessage as normal,
// then — only if that call is the one that just brought the request to
// ready_for_pricing — resolves customerType for real (reads the client's
// phone via clients' public getClient() reader, never duplicated here,
// then calls determineCustomerType() from ../pricing, also never
// duplicated) and immediately runs the pricing connection.
//
// processTransferRequestForMessage() itself is deliberately left
// untouched by this — this is a separate, composing function, not a
// behavior change to the already-tested original. A future caller that
// wants the plain (no auto-pricing) behavior — e.g. an email integration
// that isn't ready to price automatically — can still call
// processTransferRequestForMessage() directly.
//
// No new race: a request only reaches ready_for_pricing inside this same
// call (the partial unique index guarantees at most one
// collecting_info/ready_for_pricing row per client, so no concurrent call
// can independently drive the same request there), and
// runPricingForTransferRequest() is already idempotent — a defensive
// double-trigger is a safe no-op, not a duplicate price.
export async function processTransferRequestForMessageAndPrice(
  input: TransferRequestMessageInput,
): Promise<TransferRequest> {
  const target = await processTransferRequestForMessage(input);
  if (target.status !== "ready_for_pricing") {
    return target;
  }

  // Availability runs BEFORE pricing (founder-confirmed sequence: Maps
  // one-way -> Availability -> Pricing -> pending_admin_approval), and
  // never blocks it — runAvailabilityForTransferRequest never throws for a
  // Maps failure or an infeasible result, only for a genuinely missing
  // transfer_request (already ruled out, `target` was just returned by
  // processTransferRequestForMessage above).
  //
  // previousService is hardcoded to null here — see
  // runAvailabilityForTransferRequest's own doc comment for exactly why:
  // `bookings` has no pickup/destination/duration columns yet (Booking
  // Snapshot milestone, not this one), so there is no real "last confirmed
  // service" to query. Every Availability result produced by the live
  // pipeline today is therefore evaluated as if it were the first service
  // of the day (relocationOrigin = Sondrio) — an honest reflection of the
  // current data, not a shortcut.
  const withAvailability = await runAvailabilityForTransferRequest(input.tenantId, target.id, null);

  const client = await getClient(input.tenantId, withAvailability.clientId);
  if (!client) {
    // Unreachable in practice: client_id is a NOT NULL foreign key to a
    // row that must already exist (processTransferRequestForMessage never
    // creates a transfer_request without a real client). Guarded rather
    // than silently swallowed, same discipline as this module's other
    // invariant checks.
    throw new Error(`processTransferRequestForMessageAndPrice: client ${withAvailability.clientId} not found`);
  }

  const customerType = determineCustomerType(client.phone);
  const priced = await runPricingForTransferRequest(input.tenantId, withAvailability.id, customerType);

  // Phase 2.5 — a real price/offer now exists: the deal moves from "open"
  // (collecting data) to "quoted" (an offer exists, still active for
  // matching — see packages/core/src/deals's state machine). Forward-only
  // (advanceDealStatus never regresses an already-further-along deal), and
  // guarded on dealId being set at all — never set for a transfer_request
  // that predates this phase (see 0024_deals_backfill.sql), in which case
  // this is a safe no-op.
  if (priced.dealId && priced.status === "pending_admin_approval") {
    await advanceDealStatus(input.tenantId, priced.dealId, "quoted");
  }

  return priced;
}

// ── Booking Snapshot (transfer_request -> booking) ────────────────────────
// Helpers used only by acceptTransferRequest/modifyPriceForTransferRequest
// below, to resolve every field ensureBookingForApprovedTransferRequest
// (packages/core/src/bookings, never duplicated here) needs before an
// approved transfer_request becomes a confirmed booking.

const BOOKING_TIMEZONE = "Europe/Rome";

// How many minutes `timeZone`'s wall clock is ahead of UTC at the instant
// `date` represents (e.g. +60 for Rome in CET, +120 in CEST) — the
// standard Intl-only technique (format `date` in the target zone, re-read
// those wall-clock numbers as if they were UTC, diff against the real UTC
// instant). No new dependency (luxon/date-fns-tz): Node 20's built-in
// full-ICU Intl is already enough, same "don't add a package for what the
// platform already provides" discipline as the rest of this codebase.
function getTimeZoneOffsetMinutes(timeZone: string, date: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    parts.hour === "24" ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - date.getTime()) / 60_000;
}

// requestedDate/requestedTime are the customer's wall-clock request in
// Europe/Rome — Bonolini Transfer's only market — never the server
// process's own timezone. Deliberately NOT shared with
// runAvailabilityForTransferRequest's own (naive, process-timezone)
// candidateStartAt construction above — a founder decision scoped to this
// milestone only, to avoid changing already-shipped, already-tested
// Availability arithmetic; see README.md's "Booking Snapshot" section for
// the known gap this leaves (Availability's feasibility decision and this
// function's scheduledAt can disagree by the CET/CEST offset if the server
// process itself isn't running in Europe/Rome) and why it's accepted for
// now rather than fixed here.
//
// Returns null — never an invented fallback time — when requestedDate/
// requestedTime don't round-trip to a real calendar date/time (e.g. month
// 13, a malformed string).
function toScheduledAtEuropeRome(requestedDate: string, requestedTime: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(requestedDate);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(requestedTime);
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);

  const provisional = Date.UTC(year, month - 1, day, hour, minute, 0);
  const roundTrip = new Date(provisional);
  const isRealCalendarDateTime =
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day &&
    roundTrip.getUTCHours() === hour &&
    roundTrip.getUTCMinutes() === minute;
  if (!isRealCalendarDateTime) return null;

  const offsetMinutes = getTimeZoneOffsetMinutes(BOOKING_TIMEZONE, roundTrip);
  return new Date(provisional - offsetMinutes * 60_000);
}

// Resolves the one-way pickup -> destination minutes the booking snapshot
// requires, never leaving it null. Reuses existing.customerTripDurationMinutes
// when Availability already resolved it; only falls back to a fresh Maps
// call (packages/core/src/maps-distance's calculateRoute, never duplicated
// here — the same call runAvailabilityForTransferRequest itself makes) when
// it didn't (a Maps failure, or a malformed requestedDate/requestedTime, at
// Availability time — see runAvailabilityForTransferRequest above). On
// success, also persists the resolved value back onto the transfer_request
// row (best-effort side update) so a retried ACCEPT/MODIFY_PRICE never
// needs to call Maps twice for the same request.
//
// Throws — never invents a duration, never lets a booking get created with
// a null one — when Maps itself fails. The founder-confirmed rule: no
// booking is ever created with customerTripDurationMinutes null.
async function resolveCustomerTripDurationMinutesForBooking(existing: TransferRequest): Promise<number> {
  if (existing.customerTripDurationMinutes !== null) {
    return existing.customerTripDurationMinutes;
  }

  if (!existing.pickup || !existing.destination) {
    // Unreachable in practice: guaranteed non-null by computeMissingInformation
    // before status can reach pending_admin_approval — guarded rather than
    // silently trusted, same discipline as this module's other invariant
    // checks.
    throw new Error(
      `resolveCustomerTripDurationMinutesForBooking: transfer_request ${existing.id} is missing pickup/destination`,
    );
  }

  const routeResult = await calculateRoute([existing.pickup, existing.destination]);
  if (routeResult.status !== "ok" || routeResult.durationMinutes === null) {
    // "booking creation failed" prefix is deliberate — the router
    // pattern-matches on it to distinguish "an external dependency is
    // temporarily unavailable" from the CONFLICT (bad state transition)
    // errors this module's other throws represent. See router.ts.
    throw new Error(
      `booking creation failed: maps could not resolve a one-way duration for transfer_request ${existing.id} ` +
        `(${routeResult.error?.code ?? "unknown_error"}: ${routeResult.error?.message ?? "no details"})`,
    );
  }

  // Same single eq(id) convention as acceptTransferRequest/
  // modifyPriceForTransferRequest's own updates below — `existing` was
  // already fetched tenant-scoped via getTransferRequest, so id alone
  // (globally unique) is enough here too.
  const db = getDb();
  await db
    .update(transferRequests)
    .set({ customerTripDurationMinutes: routeResult.durationMinutes, updatedAt: new Date() })
    .where(eq(transferRequests.id, existing.id));

  return routeResult.durationMinutes;
}

// Orchestrates the Booking Snapshot: resolves every field
// ensureBookingForApprovedTransferRequest (packages/core/src/bookings,
// never duplicated here) needs, then delegates the actual idempotent
// insert to it — this function itself never touches the bookings table
// directly, keeping the module boundary ADR 0002 requires (transfer-requests
// reaches bookings only through its exported interface, ../bookings).
//
// Called from both acceptTransferRequest and modifyPriceForTransferRequest,
// always AFTER their own transfer_requests update to 'approved' has already
// committed (Opzione A — sequential, idempotent steps, no db.transaction()
// in this milestone, consistent with the rest of this module). If this
// function throws, the transfer_request is already 'approved' with no
// booking yet — a recoverable, detectable state: a retried ACCEPT call
// (idempotent for any 'approved' status, see acceptTransferRequest) simply
// calls this again, never rolling back the approval itself.
async function ensureBookingForApprovedTransferRequestOrThrow(
  tenantId: string,
  approved: TransferRequest,
  depositAmountCents?: number,
): Promise<Booking> {
  if (!approved.pickup || !approved.destination || !approved.requestedDate || !approved.requestedTime) {
    // Unreachable in practice: guaranteed non-null before status could ever
    // reach pending_admin_approval — guarded rather than silently trusted.
    throw new Error(
      `ensureBookingForApprovedTransferRequestOrThrow: transfer_request ${approved.id} is missing pickup/destination/requestedDate/requestedTime`,
    );
  }
  if (approved.finalAmountCents === null) {
    // Unreachable in practice: acceptTransferRequest/modifyPriceForTransferRequest
    // both set finalAmountCents in the same update that sets status='approved'.
    throw new Error(
      `ensureBookingForApprovedTransferRequestOrThrow: transfer_request ${approved.id} has no finalAmountCents`,
    );
  }

  const scheduledAt = toScheduledAtEuropeRome(approved.requestedDate, approved.requestedTime);
  if (!scheduledAt) {
    throw new Error(
      `booking creation failed: invalid requestedDate/requestedTime on transfer_request ${approved.id}: ` +
        `'${approved.requestedDate}' '${approved.requestedTime}'`,
    );
  }

  // Only foreign customers pay a deposit (founder decision 2026-09-26),
  // enforced here so every approval path follows it. Ignored on the
  // idempotent retry path: an existing booking keeps what it was created
  // with (ON CONFLICT DO NOTHING).
  const client = await getClient(tenantId, approved.clientId);
  if (!client) {
    throw new Error(`booking creation failed: client ${approved.clientId} not found`);
  }
  let deposit: number | null = null;
  if (customerPaysDeposit(client.phone)) {
    deposit = depositAmountCents ?? computeDefaultDepositCents(approved.finalAmountCents);
    if (!isValidDeposit(deposit, approved.finalAmountCents)) {
      throw new Error(
        `invalid deposit ${deposit} for transfer_request ${approved.id} (total ${approved.finalAmountCents})`,
      );
    }
  } else if (depositAmountCents !== undefined) {
    throw new Error(`cliente italiano: nessun acconto (transfer_request ${approved.id})`);
  }

  const customerTripDurationMinutes = await resolveCustomerTripDurationMinutesForBooking(approved);

  return ensureBookingForApprovedTransferRequest(tenantId, {
    transferRequestId: approved.id,
    clientId: approved.clientId,
    dealId: approved.dealId ?? undefined,
    pickup: approved.pickup,
    destination: approved.destination,
    pickupAddress: approved.pickupAddress,
    destinationAddress: approved.destinationAddress,
    customerTripDurationMinutes,
    scheduledAt,
    finalAmountCents: approved.finalAmountCents,
    currency: approved.currency,
    depositAmountCents: deposit,
  });
}

// Phase 2.5 — wires the existing, never-used transfer_requests.quote_id
// column: reuses an existing quotes row for this deal if one already
// exists (getQuoteForDeal), or creates one otherwise. A no-op (returns
// null) when the transfer_request has no deal_id at all — a row that
// predates this phase, or in any future path that doesn't go through the
// deal layer. Deliberately bookkeeping only: no message is ever sent to
// the customer here or anywhere else in this codebase — see
// packages/core/src/deals/README.md's "Quotes" section for why
// status: "sent" carries no such meaning.
async function ensureQuoteForDeal(
  tenantId: string,
  approved: TransferRequest,
): Promise<string | null> {
  if (!approved.dealId) return null;

  const existing = await getQuoteForDeal(tenantId, approved.dealId);
  if (existing) return existing.id;

  const created = await createQuote(tenantId, {
    clientId: approved.clientId,
    dealId: approved.dealId,
    amountCents: approved.finalAmountCents ?? undefined,
    currency: approved.currency,
    status: "sent",
  });
  return created.id;
}

// Shared by acceptTransferRequest and modifyPriceForTransferRequest, both
// on the fresh-approval path and the idempotent already-approved retry —
// links transfer_requests.quote_id (ensureQuoteForDeal above). The deal
// stays "quoted": it becomes "confirmed" only when the deposit is recorded
// (bookings.confirmBookingDeposit), never at approval.
async function linkQuoteForApproval(tenantId: string, approved: TransferRequest): Promise<TransferRequest> {
  const quoteId = await ensureQuoteForDeal(tenantId, approved);

  let result = approved;
  if (quoteId && approved.quoteId !== quoteId) {
    const db = getDb();
    const rows = await db
      .update(transferRequests)
      .set({ quoteId, updatedAt: new Date() })
      .where(eq(transferRequests.id, approved.id))
      .returning();
    result = assertOne(rows, "linkQuoteForApproval");
  }

  return result;
}

// ── Admin decision (ACCEPT / REJECT / MODIFY PRICE) ──────────────────────
// The only three functions that move a transfer_request out of
// pending_admin_approval. Deliberately separate from runPricingForTransferRequest:
// pricing decides WHAT the engine computed, this decides what an admin DID
// about it. calculatedAmountCents (the engine's own output) is never
// overwritten by any of these three — finalAmountCents is the one column
// every future consumer that represents the actually-approved service
// (quote, booking, calendar event) must read instead. See README.md's
// "Admin decision" section for the full rationale, including why this
// split exists (recovered as a deliberate fix during the CChiefGrowthAI
// audit — the old bot had no such split, and a price an admin negotiated
// by hand could silently diverge from the price it later wrote onto a
// calendar event).

// Invariant guaranteed by runPricingForTransferRequest: status only ever
// reaches pending_admin_approval when pricingStatus is 'fixed' or
// 'calculated_km', both of which always set calculatedAmountCents — never
// 'manual_required'. Guarded rather than silently trusted, same discipline
// as this module's other invariant checks.
function assertCalculatedAmount(existing: TransferRequest, caller: string): number {
  if (existing.calculatedAmountCents === null) {
    throw new Error(`${caller}: transfer_request ${existing.id} has no calculatedAmountCents`);
  }
  return existing.calculatedAmountCents;
}

// pending_admin_approval -> approved, at the engine's own computed price
// (finalAmountCents = calculatedAmountCents, copied explicitly, never left
// as an implicit alias). priceOverrideReason stays null — its nullness is
// exactly what distinguishes a plain ACCEPT from a MODIFY_PRICE outcome,
// both of which land on the same 'approved' status.
//
// Idempotent for ANY prior approval — via a plain ACCEPT or via
// MODIFY_PRICE — never touching finalAmountCents/priceOverrideReason again
// in that case, only ensuring the booking snapshot exists (see
// ensureBookingForApprovedTransferRequestOrThrow above). This is
// deliberately wider than the original "no price override" condition this
// guard used before the Booking Snapshot milestone: it is now also the
// retry path for a booking that failed to get created after a prior
// ACCEPT/MODIFY_PRICE (e.g. Maps was down) — founder-confirmed widening,
// see README.md's "Booking Snapshot" section. Any other
// non-pending_admin_approval status is still a real error, not a silent
// no-op.
//
// depositAmountCents: the deposit a foreign customer is asked for; defaults
// to computeDefaultDepositCents(final price), booking at 'pending_deposit'.
// Italian customers never pay one (passing it is an error): booking at
// 'pending_confirmation'.
export async function acceptTransferRequest(
  tenantId: string,
  id: string,
  adminProfileId: string,
  depositAmountCents?: number,
): Promise<TransferRequest> {
  const db = getDb();
  const existing = await getTransferRequest(tenantId, id);
  if (!existing) {
    throw new Error(`acceptTransferRequest: no transfer_request found for id ${id}`);
  }

  if (existing.status === "approved") {
    const reconciled = await linkQuoteForApproval(tenantId, existing);
    await ensureBookingForApprovedTransferRequestOrThrow(tenantId, reconciled, depositAmountCents);
    return reconciled;
  }

  if (existing.status !== "pending_admin_approval") {
    throw new Error(
      `acceptTransferRequest: transfer_request ${id} is '${existing.status}', not 'pending_admin_approval'`,
    );
  }

  const calculatedAmountCents = assertCalculatedAmount(existing, "acceptTransferRequest");

  const rows = await db
    .update(transferRequests)
    .set({
      status: "approved",
      finalAmountCents: calculatedAmountCents,
      priceOverrideReason: null,
      adminApprovedAt: new Date(),
      adminApprovedBy: adminProfileId,
      updatedAt: new Date(),
    })
    .where(eq(transferRequests.id, id))
    .returning();

  const approved = assertOne(rows, "acceptTransferRequest");
  const updated = await linkQuoteForApproval(tenantId, approved);
  await ensureBookingForApprovedTransferRequestOrThrow(tenantId, updated, depositAmountCents);

  // Fire-and-forget, fail-soft — only on the fresh transition to
  // 'approved', never on the idempotent early-return above (that would
  // re-emit for a confirmation that already happened).
  void emitDomainEvent(inngest, "transfer_request.confirmed", {
    tenantId,
    transferRequestId: updated.id,
    finalAmountCents: updated.finalAmountCents ?? 0,
  });

  return updated;
}

// pending_admin_approval -> cancelled. Reuses the existing cancelled_reason
// free-text field (founder decision) rather than adding a 'rejected'
// status value — 'rejected_by_admin', or 'rejected_by_admin: <note>' when
// an optional note is given. The fixed 'rejected_by_admin' prefix (never
// replaced by the note) is what keeps the idempotency check below reliable
// regardless of what note text, if any, was supplied.
// finalAmountCents is deliberately never touched here (left at whatever it
// already was — null, since this is only reachable from
// pending_admin_approval, which never sets it).
//
// Idempotent only for the exact case of retrying an identical prior
// REJECT (already cancelled, specifically by an admin). A request already
// cancelled for a different reason (e.g. 'superseded_by_new_request', see
// cancelSuperseded()) is a real error, not silently treated as "already
// rejected" — overwriting a system-driven cancellation's reason would lose
// information.
// "Prezzo da inserire" in the admin panel (founder decision, 2026-09-25): a
// request the pricing engine could not price (ready_for_pricing +
// manual_required) moves to pending_admin_approval with a price typed by
// the founder. calculatedAmountCents stays null — it only ever holds the
// engine's own output — and the typed price is recorded in
// pricingBreakdown.manualPrice. Nothing is approved and nothing is sent
// here: the price still goes through Approva (modifyPriceForTransferRequest).
//
// Conditional UPDATE: of two concurrent calls only one moves the request;
// the other (and any call on a request no longer in that state) gets null.
export async function enterManualPriceForTransferRequest(
  tenantId: string,
  id: string,
  amountCents: number,
  enteredByProfileId: string,
): Promise<TransferRequest | null> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`enterManualPriceForTransferRequest: invalid amount ${amountCents}`);
  }
  const existing = await getTransferRequest(tenantId, id);
  if (!existing) return null;

  const previousBreakdown =
    existing.pricingBreakdown && typeof existing.pricingBreakdown === "object"
      ? (existing.pricingBreakdown as Record<string, unknown>)
      : {};

  const db = getDb();
  const [updated] = await db
    .update(transferRequests)
    .set({
      status: "pending_admin_approval",
      pricingBreakdown: {
        ...previousBreakdown,
        manualPrice: { amountCents, enteredBy: enteredByProfileId, enteredAt: new Date().toISOString() },
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(transferRequests.tenantId, tenantId),
        eq(transferRequests.id, id),
        eq(transferRequests.status, "ready_for_pricing"),
        eq(transferRequests.pricingStatus, "manual_required"),
      ),
    )
    .returning();

  if (!updated) return null;
  if (updated.dealId) {
    await advanceDealStatus(tenantId, updated.dealId, "quoted");
  }
  return updated;
}

export async function rejectTransferRequest(
  tenantId: string,
  id: string,
  reason?: string,
): Promise<TransferRequest> {
  const db = getDb();
  const existing = await getTransferRequest(tenantId, id);
  if (!existing) {
    throw new Error(`rejectTransferRequest: no transfer_request found for id ${id}`);
  }

  if (existing.status === "cancelled" && existing.cancelledReason?.startsWith("rejected_by_admin")) {
    return existing;
  }

  if (existing.status !== "pending_admin_approval") {
    throw new Error(
      `rejectTransferRequest: transfer_request ${id} is '${existing.status}', not 'pending_admin_approval'`,
    );
  }

  const cancelledReason = reason ? `rejected_by_admin: ${reason}` : "rejected_by_admin";

  const rows = await db
    .update(transferRequests)
    .set({
      status: "cancelled",
      cancelledReason,
      updatedAt: new Date(),
    })
    .where(eq(transferRequests.id, id))
    .returning();

  return assertOne(rows, "rejectTransferRequest");
}

// pending_admin_approval -> approved, at an admin-chosen price
// (finalAmountCents = amountCents, deliberately different from
// calculatedAmountCents, which this never touches). reason is required and
// non-empty — mirrors bookings.overridePrice's `reason` input documented
// in docs/domain/13-api-contracts.md, not a new convention.
//
// Deliberately NOT idempotent and NOT re-runnable once approved (founder
// decision, narrower than the other two actions here): the moment status
// reaches 'approved' — via this function or via acceptTransferRequest —
// the price-modification window is closed. A second MODIFY_PRICE call
// after that must fail loudly, never silently overwrite an
// already-approved price a second time.
export async function modifyPriceForTransferRequest(
  tenantId: string,
  id: string,
  adminProfileId: string,
  amountCents: number,
  reason: string,
  depositAmountCents?: number,
): Promise<TransferRequest> {
  if (!reason.trim()) {
    throw new Error("modifyPriceForTransferRequest: reason is required and must not be empty");
  }

  const db = getDb();
  const existing = await getTransferRequest(tenantId, id);
  if (!existing) {
    throw new Error(`modifyPriceForTransferRequest: no transfer_request found for id ${id}`);
  }

  if (existing.status !== "pending_admin_approval") {
    throw new Error(
      `modifyPriceForTransferRequest: transfer_request ${id} is '${existing.status}', not 'pending_admin_approval'`,
    );
  }

  // A request the engine could not price (manual_required) has no
  // calculated amount by definition: its only price is the one entered by
  // hand (enterManualPriceForTransferRequest), approved here.
  if (existing.pricingStatus !== "manual_required") {
    assertCalculatedAmount(existing, "modifyPriceForTransferRequest");
  }

  const rows = await db
    .update(transferRequests)
    .set({
      status: "approved",
      finalAmountCents: amountCents,
      priceOverrideReason: reason,
      adminApprovedAt: new Date(),
      adminApprovedBy: adminProfileId,
      updatedAt: new Date(),
    })
    .where(eq(transferRequests.id, id))
    .returning();

  const approved = assertOne(rows, "modifyPriceForTransferRequest");
  const updated = await linkQuoteForApproval(tenantId, approved);
  // A retry of a booking that failed to get created after THIS call
  // succeeded goes through acceptTransferRequest instead (idempotent for
  // any 'approved' status) — modifyPriceForTransferRequest itself stays
  // deliberately non-re-runnable once approved, per the founder's existing
  // rule above; this call only ensures the booking for the request this
  // invocation itself just approved.
  await ensureBookingForApprovedTransferRequestOrThrow(tenantId, updated, depositAmountCents);

  // Fire-and-forget, fail-soft — same event acceptTransferRequest emits on
  // its own fresh confirmation; this function is never re-runnable once
  // approved (see above), so there is no idempotent-retry branch to avoid
  // double-emitting from here.
  void emitDomainEvent(inngest, "transfer_request.confirmed", {
    tenantId,
    transferRequestId: updated.id,
    finalAmountCents: updated.finalAmountCents ?? 0,
  });

  return updated;
}
