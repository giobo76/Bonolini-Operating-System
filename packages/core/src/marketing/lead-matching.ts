// Pure, network-free heuristic — the ONLY place a time-proximity guess is
// allowed to exist in this module, and it never produces a "certain"
// result on its own: its entire output feeds lead_match_candidates,
// reviewed by a human, never marketing_leads.client_id directly. See
// packages/db/migrations/0017_lead_attribution.sql's header for the
// founder's explicit, binding rule this encodes: time proximity alone is
// never sufficient for "certain", even with a single non-competing
// candidate.

export interface CandidateLeadInput {
  id: string;
  createdAt: Date | string;
  channel: string;
  clientId: string | null;
  attributionConfidence: string;
}

export interface CandidateMessageInput {
  clientId: string | null;
  receivedAt: Date | string;
}

export interface CandidatePair {
  marketingLeadId: string;
  clientId: string;
  deltaMinutes: number;
}

const DEFAULT_WINDOW_MINUTES = 20;

// A lead click can only plausibly explain a client's FIRST-EVER inbound
// message — never their 5th or 50th. Filtering to each client's earliest
// message before comparing timestamps is what correctly excludes an
// existing, already-active conversation that merely happens to have a
// message land near a later, unrelated lead click (verified against real
// Production data during the 2026-09 attribution review: this exact
// pattern — a client active for over a week, message timing coincidental —
// was the majority of false candidates a naive "nearest message" search
// would have produced).
function earliestMessageByClient(messages: CandidateMessageInput[]): Map<string, number> {
  const earliest = new Map<string, number>();
  for (const message of messages) {
    if (!message.clientId) continue;
    const t = new Date(message.receivedAt).getTime();
    const existing = earliest.get(message.clientId);
    if (existing === undefined || t < existing) {
      earliest.set(message.clientId, t);
    }
  }
  return earliest;
}

// Exported for direct testing, same rationale as the other pure decision
// functions in this package.
export function findTimeProximityCandidates(
  leads: CandidateLeadInput[],
  messages: CandidateMessageInput[],
  windowMinutes: number = DEFAULT_WINDOW_MINUTES,
): CandidatePair[] {
  const firstMessageByClient = earliestMessageByClient(messages);
  const pairs: CandidatePair[] = [];

  for (const lead of leads) {
    // Only whatsapp-channel leads have a message stream to correlate
    // against at all — phone/email/form leave no trace this heuristic can
    // use (see the module README for why that's a real, not a code, gap).
    if (lead.channel !== "whatsapp") continue;
    // Already resolved (by token, visitor_id, or manual admin) — never
    // reconsidered by the heuristic, and never downgraded.
    if (lead.clientId || lead.attributionConfidence === "certain") continue;

    const leadTime = new Date(lead.createdAt).getTime();

    for (const [clientId, firstMessageTime] of firstMessageByClient) {
      const deltaMinutes = (firstMessageTime - leadTime) / 60_000;
      // Causally consistent only: the click happens, then (later) the real
      // first message arrives — never the reverse, and never outside the
      // window.
      if (deltaMinutes >= 0 && deltaMinutes <= windowMinutes) {
        pairs.push({ marketingLeadId: lead.id, clientId, deltaMinutes });
      }
    }
  }

  return pairs;
}
