import { describe, expect, it } from "vitest";
import { findTimeProximityCandidates, type CandidateLeadInput, type CandidateMessageInput } from "./lead-matching";

function lead(overrides: Partial<CandidateLeadInput> = {}): CandidateLeadInput {
  return {
    id: "lead-1",
    createdAt: "2026-08-30T16:01:10.000Z",
    channel: "whatsapp",
    clientId: null,
    attributionConfidence: "unknown",
    ...overrides,
  };
}

function message(overrides: Partial<CandidateMessageInput> = {}): CandidateMessageInput {
  return { clientId: "client-1", receivedAt: "2026-08-30T16:05:16.000Z", ...overrides };
}

describe("findTimeProximityCandidates", () => {
  it("finds a candidate for a new client's first message shortly after the lead click", () => {
    const pairs = findTimeProximityCandidates([lead()], [message()]);

    expect(pairs).toEqual([{ marketingLeadId: "lead-1", clientId: "client-1", deltaMinutes: expect.any(Number) }]);
    expect(pairs[0]!.deltaMinutes).toBeCloseTo(4.1, 1);
  });

  // Regression fixture: the real 2026-09 attribution review found this
  // exact pattern — a client already active for over a week, whose
  // ongoing conversation happened to have a message land near an
  // unrelated later lead click — was the majority of false candidates a
  // naive "nearest message" search produced.
  it("never proposes a client whose first-ever message long predates the lead (existing conversation, coincidental timing)", () => {
    const oldClientFirstMessage = message({ clientId: "existing-client", receivedAt: "2026-08-22T12:52:35.000Z" });
    const laterUnrelatedMessage = message({ clientId: "existing-client", receivedAt: "2026-08-30T20:19:51.000Z" });
    const candidateLead = lead({ id: "lead-2", createdAt: "2026-08-30T20:34:18.000Z" });

    const pairs = findTimeProximityCandidates([candidateLead], [oldClientFirstMessage, laterUnrelatedMessage]);

    expect(pairs).toEqual([]);
  });

  it("never proposes a candidate when the client's first message precedes the lead (wrong causal order)", () => {
    const firstMessage = message({ clientId: "client-bryan", receivedAt: "2026-08-28T21:25:36.000Z" });
    const candidateLead = lead({ id: "lead-3", createdAt: "2026-08-28T21:30:22.000Z" });

    // Message is BEFORE the lead here, unlike the "shortly after" case above.
    const pairs = findTimeProximityCandidates([candidateLead], [firstMessage]);

    expect(pairs).toEqual([]);
  });

  it("never proposes a candidate outside the configured window", () => {
    const farMessage = message({ receivedAt: "2026-08-30T16:25:11.000Z" }); // 24 min after
    const pairs = findTimeProximityCandidates([lead()], [farMessage], 20);

    expect(pairs).toEqual([]);
  });

  it("proposes multiple candidate pairs when two leads both precede the same client's first message (duplicate-lead-record ambiguity)", () => {
    const firstMessage = message({ clientId: "client-mario", receivedAt: "2026-08-30T16:05:16.000Z" });
    const leadA = lead({ id: "lead-chatgpt", createdAt: "2026-08-30T16:01:10.000Z" });
    const leadB = lead({ id: "lead-organic", createdAt: "2026-08-30T16:01:27.000Z" });

    const pairs = findTimeProximityCandidates([leadA, leadB], [firstMessage]);

    expect(pairs.map((p) => p.marketingLeadId).sort()).toEqual(["lead-chatgpt", "lead-organic"]);
    expect(pairs.every((p) => p.clientId === "client-mario")).toBe(true);
  });

  it("ignores a non-whatsapp lead entirely — no message stream exists to correlate against", () => {
    const pairs = findTimeProximityCandidates([lead({ channel: "email" })], [message()]);
    expect(pairs).toEqual([]);
  });

  it("ignores a lead that already has a client_id — never reconsidered by the heuristic", () => {
    const pairs = findTimeProximityCandidates([lead({ clientId: "already-linked" })], [message()]);
    expect(pairs).toEqual([]);
  });

  it("ignores a lead whose attribution_confidence is already 'certain' — never downgraded or reconsidered", () => {
    const pairs = findTimeProximityCandidates([lead({ attributionConfidence: "certain" })], [message()]);
    expect(pairs).toEqual([]);
  });

  it("ignores a message with no client_id", () => {
    const pairs = findTimeProximityCandidates([lead()], [message({ clientId: null })]);
    expect(pairs).toEqual([]);
  });

  it("only ever uses each client's earliest message, never a later one, to compute the delta", () => {
    const earliest = message({ clientId: "client-1", receivedAt: "2026-08-30T16:05:16.000Z" });
    const later = message({ clientId: "client-1", receivedAt: "2026-08-30T16:08:09.000Z" });

    const pairs = findTimeProximityCandidates([lead()], [later, earliest]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.deltaMinutes).toBeCloseTo(4.1, 1);
  });
});
