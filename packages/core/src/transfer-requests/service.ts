import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, transferRequests, whatsappMessages, assertOne, type TransferRequest } from "@bos/db";
import { calculatePrice, determineCustomerType, type CustomerType } from "../pricing";
import { getClient } from "../clients";
import type { TransferRequestExtractedFields } from "./schema";

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
  // "andata" (towards an airport) needs a time; "ritorno" (from an airport)
  // needs a flight number — same direzione logic as determina_direzione().
  if (isAirport(fields.destination) && !fields.requestedTime) missing.push("time");
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
): Promise<TransferRequest | null> {
  const db = getDb();
  const missing = computeMissingInformation(toCompletenessFields(extracted));
  const status = missing.length === 0 ? "ready_for_pricing" : "collecting_info";

  const insertedRows = await db.execute<TransferRequest>(sql`
    insert into transfer_requests (
      tenant_id, client_id, status, intent, pickup, destination,
      requested_date, requested_time, passengers, luggage,
      flight_number, train_number, hotel, language
    ) values (
      ${tenantId}, ${clientId}, ${status},
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
    .set({ missingInformation: missing })
    .where(eq(transferRequests.id, created.id))
    .returning();
  return withMissing ?? created;
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
): Promise<TransferRequest> {
  const created = await insertNewTransferRequest(tenantId, clientId, extracted);
  if (created) return created;

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
// NOT wired into the live webhook pipeline in this milestone — see
// README.md's "Integration is a separate, deliberate next step".
export async function processTransferRequestForMessage(
  input: TransferRequestMessageInput,
): Promise<TransferRequest> {
  const db = getDb();

  const [messageRow] = await db
    .select({ transferRequestId: whatsappMessages.transferRequestId })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.id, input.whatsappMessageId));

  if (messageRow?.transferRequestId) {
    const already = await getTransferRequest(input.tenantId, messageRow.transferRequestId);
    if (already) return already;
  }

  const openRequest = await findOpenTransferRequest(input.tenantId, input.clientId);

  let target: TransferRequest;

  if (!openRequest) {
    // Covers: genuinely the first message, OR the client's only request is
    // locked in pending_admin_approval/approved (invisible to matching by
    // design), OR their prior request is already converted_to_quote/
    // cancelled/expired (rules 6/7 of the approved spec).
    target = await createOrMergeAsNewRequest(input.tenantId, input.clientId, input.extracted);
  } else if (hasRouteConflict(openRequest, input.extracted)) {
    await cancelSuperseded(openRequest);
    target = await createOrMergeAsNewRequest(input.tenantId, input.clientId, input.extracted);
  } else {
    target = await mergeIntoTransferRequest(openRequest, input.extracted);
  }

  await db
    .update(whatsappMessages)
    .set({ transferRequestId: target.id })
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

  // distanceKm/requestedServiceType/channel/possibleNightOrHolidaySurcharge
  // have no source on transfer_requests today (no Maps integration, no
  // serviceType/channel columns) — always the conservative default, which
  // the pricing engine already handles as manual_required where it matters
  // (e.g. any km-based route defers with reason "distance_not_provided"
  // until a real distance is available). Not a workaround: this is the
  // honest, current state of what this connection can compute.
  const pricingResult = calculatePrice({
    customerType,
    pickup: existing.pickup,
    destination: existing.destination,
    passengers: existing.passengers,
    requestedServiceType: "point_to_point",
    channel: "direct",
    possibleNightOrHolidaySurcharge: false,
  });

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
      },
      updatedAt: new Date(),
    })
    .where(eq(transferRequests.id, id))
    .returning();

  return assertOne(rows, "runPricingForTransferRequest");
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

  const client = await getClient(input.tenantId, target.clientId);
  if (!client) {
    // Unreachable in practice: client_id is a NOT NULL foreign key to a
    // row that must already exist (processTransferRequestForMessage never
    // creates a transfer_request without a real client). Guarded rather
    // than silently swallowed, same discipline as this module's other
    // invariant checks.
    throw new Error(`processTransferRequestForMessageAndPrice: client ${target.clientId} not found`);
  }

  const customerType = determineCustomerType(client.phone);
  return runPricingForTransferRequest(input.tenantId, target.id, customerType);
}
