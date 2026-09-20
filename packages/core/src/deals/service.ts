import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, deals, transferRequests, bookings, assertOne, type Deal } from "@bos/db";
import { ACTIVE_DEAL_STATUSES, DEAL_STATUS_RANK, type DealStatus, type DealMatchCandidate } from "./schema";

// How far back a cancelled deal is still eligible for
// reopenRecentClosedDealIfMatching's reuse — long enough to cover "the
// customer went quiet for a day or two then came back with the same trip",
// short enough that an unrelated request months later never resurrects old
// context. A deliberate, documented number, not a magic constant: see
// README.md's "Anti-duplication" section.
const REOPEN_WINDOW_HOURS = 72;

function normalize(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.trim().toLowerCase();
}

export async function createDeal(tenantId: string, clientId: string): Promise<Deal> {
  const db = getDb();
  // Raw INSERT ... RETURNING, same convention every other "create a new
  // row and hand it back" write in this codebase uses (insertNewTransferRequest,
  // findOrCreateClientByPhone, ensureBookingForApprovedTransferRequest) —
  // no ON CONFLICT target here: deals has no uniqueness constraint by
  // design (dedup is an application-level decision, see
  // findMatchingDealForMessage, never a DB-level one — README.md's
  // "Anti-duplication" section explains why).
  const rows = await db.execute<Deal>(sql`
    insert into deals (tenant_id, client_id, status, last_message_at)
    values (${tenantId}, ${clientId}, 'open', now())
    returning *
  `);
  return assertOne(rows, "createDeal");
}

export async function getDeal(tenantId: string, id: string): Promise<Deal | null> {
  const db = getDb();
  const [row] = await db.select().from(deals).where(and(eq(deals.tenantId, tenantId), eq(deals.id, id)));
  return row ?? null;
}

// Every deal for this client, most recently touched first — filtered to
// ACTIVE_DEAL_STATUSES in plain JS, same "fetch the small bounded set, then
// filter in code" pattern transfer-requests' own findOpenTransferRequest
// uses (a client's lifetime deal count is small; the tenant+client index
// keeps the fetch itself cheap either way).
export async function getActiveDealsForClient(tenantId: string, clientId: string): Promise<Deal[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(deals)
    .where(and(eq(deals.tenantId, tenantId), eq(deals.clientId, clientId)))
    .orderBy(desc(deals.lastMessageAt));
  return rows.filter((row) => (ACTIVE_DEAL_STATUSES as readonly string[]).includes(row.status));
}

// Read-only lookup against transfer_requests directly (the table, via
// @bos/db — never the transfer-requests MODULE, which itself imports this
// module: importing it back here would form a circular module dependency).
// Used only for this module's own matching decisions (disambiguation,
// reopen eligibility) — never exported, never a write path. "Current"
// attempt = most recently created transfer_request under this deal,
// mirroring transfer-requests' own "most recent wins" convention.
async function getMostRecentTransferRequestForDeal(
  tenantId: string,
  dealId: string,
): Promise<{ pickup: string | null; destination: string | null; requestedDate: string | null } | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(transferRequests)
    .where(and(eq(transferRequests.tenantId, tenantId), eq(transferRequests.dealId, dealId)))
    .orderBy(desc(transferRequests.createdAt));
  return rows[0] ?? null;
}

// Rule 5 of the matching algorithm: when a client has more than one
// simultaneously active deal (two genuinely different trips — rule E/F),
// disambiguate deterministically by how strongly this message's
// pickup/destination/date matches each deal's current transfer_request,
// never by the message's free-text intent (rule 4: no AI/semantic
// criterion where a deterministic one is available). Ties (including "no
// deal scored anything") fall back to getActiveDealsForClient's own
// ordering, already most-recently-touched-first — a real, logged
// deterministic tie-break, not a guess.
function scoreCandidate(
  candidate: DealMatchCandidate,
  transferRequest: { pickup: string | null; destination: string | null; requestedDate: string | null } | null,
): number {
  if (!transferRequest) return 0;
  let score = 0;
  if (candidate.pickup && normalize(candidate.pickup) === normalize(transferRequest.pickup)) score += 1;
  if (candidate.destination && normalize(candidate.destination) === normalize(transferRequest.destination)) score += 1;
  if (candidate.date && transferRequest.requestedDate && candidate.date === transferRequest.requestedDate) score += 1;
  return score;
}

async function disambiguateActiveDeals(
  tenantId: string,
  activeDeals: Deal[],
  candidate: DealMatchCandidate,
): Promise<Deal> {
  let best = activeDeals[0]!;
  let bestScore = -1;
  for (const deal of activeDeals) {
    const currentTransferRequest = await getMostRecentTransferRequestForDeal(tenantId, deal.id);
    const score = scoreCandidate(candidate, currentTransferRequest);
    if (score > bestScore) {
      bestScore = score;
      best = deal;
    }
  }
  return best;
}

// Rule 4 of the matching algorithm: no active deal exists, but a recently
// CANCELLED one (never "completed" — a completed deal already had a real,
// fulfilled booking; resuming it is a materially different, riskier claim
// than resuming an abandoned one, and the task's own required test case
// ["old completed deal NON reopening"] is exactly this distinction) with a
// strong pickup+destination match, inside the reopen window, and with no
// booking ever recorded against it, is reopened instead of silently
// spawning an unrelated new deal for the same trip. "No booking/pagamento
// verificato" (the task's own condition) is checked directly against
// `bookings`, not inferred from deal.status alone — belt and suspenders.
export async function reopenRecentClosedDealIfMatching(
  tenantId: string,
  clientId: string,
  candidate: DealMatchCandidate,
): Promise<Deal | null> {
  if (!candidate.pickup || !candidate.destination) return null;

  const db = getDb();
  const cutoff = new Date(Date.now() - REOPEN_WINDOW_HOURS * 60 * 60 * 1000);

  const rows = await db
    .select()
    .from(deals)
    .where(and(eq(deals.tenantId, tenantId), eq(deals.clientId, clientId)))
    .orderBy(desc(deals.updatedAt));

  const eligible = rows.filter((row) => row.status === "cancelled" && row.updatedAt >= cutoff);

  for (const deal of eligible) {
    const currentTransferRequest = await getMostRecentTransferRequestForDeal(tenantId, deal.id);
    if (!currentTransferRequest) continue;

    const pickupMatches = normalize(candidate.pickup) === normalize(currentTransferRequest.pickup);
    const destinationMatches = normalize(candidate.destination) === normalize(currentTransferRequest.destination);
    const dateMatches = !candidate.date || candidate.date === currentTransferRequest.requestedDate;
    if (!pickupMatches || !destinationMatches || !dateMatches) continue;

    const [existingBooking] = await db.select().from(bookings).where(eq(bookings.dealId, deal.id));
    if (existingBooking) continue;

    const [reopened] = await db
      .update(deals)
      .set({ status: "open", updatedAt: new Date() })
      .where(and(eq(deals.tenantId, tenantId), eq(deals.id, deal.id)))
      .returning();
    return reopened ?? null;
  }

  return null;
}

export interface DealMatchResult {
  deal: Deal;
  // true only when this exact call created the deal (no active or
  // reopenable one existed) — mirrors findOrCreateClientByPhone's own
  // isNew convention.
  isNew: boolean;
  reopened: boolean;
}

// The module's single entry point (rule 5-8 of the approved matching
// algorithm): resolves the deal a message belongs to, in priority order —
// (1) the client's one active deal, (2) disambiguated among several active
// deals, (3) a recently-cancelled deal worth reopening, (4) a brand new
// deal. Deliberately never looks at the message's own transfer_request_id
// or whatsapp_message linkage — that idempotency/short-circuit check
// happens one layer up, in transfer-requests/service.ts, before this is
// ever called (see its own doc comment for why: this module has no
// business knowing about whatsapp_messages at all, per ADR 0002).
export async function findMatchingDealForMessage(
  tenantId: string,
  clientId: string,
  candidate: DealMatchCandidate,
): Promise<DealMatchResult> {
  const activeDeals = await getActiveDealsForClient(tenantId, clientId);

  if (activeDeals.length === 1) {
    return { deal: activeDeals[0]!, isNew: false, reopened: false };
  }

  if (activeDeals.length > 1) {
    const deal = await disambiguateActiveDeals(tenantId, activeDeals, candidate);
    return { deal, isNew: false, reopened: false };
  }

  const reopened = await reopenRecentClosedDealIfMatching(tenantId, clientId, candidate);
  if (reopened) {
    return { deal: reopened, isNew: false, reopened: true };
  }

  const created = await createDeal(tenantId, clientId);
  return { deal: created, isNew: true, reopened: false };
}

// Bumped every time a message is matched to this deal (whether or not it
// changes the deal's transfer_request) — the freshness signal
// disambiguation/reopen read, and the plain "when did we last hear from
// this client about this deal" fact for a future admin view.
export async function touchDealLastMessageAt(tenantId: string, id: string, at: Date): Promise<void> {
  const db = getDb();
  await db
    .update(deals)
    .set({ lastMessageAt: at, updatedAt: new Date() })
    .where(and(eq(deals.tenantId, tenantId), eq(deals.id, id)));
}

// Forward-only: never regresses a deal's status (see DEAL_STATUS_RANK's own
// comment). Called from transfer-requests/service.ts when the underlying
// transfer_request reaches pending_admin_approval (-> "quoted") or a
// booking is created (-> "confirmed") — never called with "completed"/
// "cancelled", which only ever happen through the explicit closeDeal below.
export async function advanceDealStatus(tenantId: string, id: string, target: DealStatus): Promise<Deal | null> {
  const existing = await getDeal(tenantId, id);
  if (!existing) return null;
  if (DEAL_STATUS_RANK[target] <= DEAL_STATUS_RANK[existing.status]) return existing;

  const db = getDb();
  const rows = await db
    .update(deals)
    .set({ status: target, updatedAt: new Date() })
    .where(and(eq(deals.tenantId, tenantId), eq(deals.id, id)))
    .returning();
  return assertOne(rows, "advanceDealStatus");
}

// The only function that ever sets "completed" or "cancelled" — an
// explicit decision, never inferred. Not wired to any automatic trigger in
// this phase (no notifications/billing module exists yet to call it from —
// see the phase's own explicit exclusions); exposed for a future admin
// action or booking.completed listener to call.
export async function closeDeal(tenantId: string, id: string, status: "completed" | "cancelled"): Promise<Deal> {
  const db = getDb();
  const rows = await db
    .update(deals)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(deals.tenantId, tenantId), eq(deals.id, id)))
    .returning();
  return assertOne(rows, "closeDeal");
}

// Deliberately narrow: a free-text label a customer's message intent was
// tagged with (by the existing WhatsApp parser — see
// packages/core/src/whatsapp/parser.ts, never re-invoked or re-interpreted
// here) containing "payment" is the one deterministic signal this phase
// uses — never a new AI call, never the message's raw text scanned for
// keywords (that would be reintroducing an ad hoc heuristic the founder's
// rule 4 explicitly rules out). False negatives (a payment mention the
// parser didn't label as such) are expected and acceptable: this is a
// convenience note for a human to notice, never a payment system.
export function looksLikeCustomerReportedPayment(intent: string | null | undefined): boolean {
  return typeof intent === "string" && intent.toLowerCase().includes("payment");
}

// Records ONLY that the customer's message claimed a payment — never
// "paid", never "payment_verified", never anything a booking/billing flow
// could mistake for a real reconciled transaction. See README.md's
// "Payments" section for the full rationale (no payments/billing system
// exists in this phase, deliberately).
export async function recordCustomerReportedPayment(
  tenantId: string,
  id: string,
  note: string,
  at: Date,
): Promise<void> {
  const db = getDb();
  await db
    .update(deals)
    .set({ customerReportedPaymentNote: note, customerReportedPaymentAt: at, updatedAt: new Date() })
    .where(and(eq(deals.tenantId, tenantId), eq(deals.id, id)));
}
