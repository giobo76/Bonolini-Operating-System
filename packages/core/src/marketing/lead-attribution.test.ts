import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Client, MarketingLead } from "@bos/db";

// @bos/db fully mocked, keyed by table identity — same strategy as
// whatsapp/service.test.ts and business-kpis.test.ts. Covers
// confirmLeadByContactToken (deterministic token reconciliation) and
// recordAmbiguousLeadCandidates/listLeadMatchCandidates (the heuristic
// candidate path) — kept in their own file, separate from service.test.ts,
// since they touch a different set of tables (lead_match_candidates,
// whatsapp_messages) than that file's existing mock covers.

const { fakeState, marketingLeadsTable, clientsTable, whatsappMessagesTable, leadMatchCandidatesTable } = vi.hoisted(
  () => {
    return {
      fakeState: {
        leads: [] as Array<Record<string, unknown>>,
        messages: [] as Array<Record<string, unknown>>,
        candidates: [] as Array<Record<string, unknown>>,
        leadUpdateCalls: [] as Array<Record<string, unknown>>,
        clientUpdateCalls: [] as Array<{ id: unknown; values: Record<string, unknown> }>,
        candidateInsertCalls: [] as Array<Record<string, unknown>>,
        nextCandidateId: 1,
      },
      marketingLeadsTable: { __name: "marketingLeads" },
      clientsTable: { __name: "clients" },
      whatsappMessagesTable: { __name: "whatsappMessages" },
      leadMatchCandidatesTable: { __name: "leadMatchCandidates" },
    };
  },
);

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  return {
    orderBy: () => promise,
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => promise.then(resolve, reject),
    catch: (reject: (e: unknown) => void) => promise.catch(reject),
  };
}

vi.mock("@bos/db", () => ({
  marketingLeads: marketingLeadsTable,
  clients: clientsTable,
  whatsappMessages: whatsappMessagesTable,
  leadMatchCandidates: leadMatchCandidatesTable,
  assertOne: (rows: unknown[], context: string) => {
    const row = rows[0];
    if (!row) throw new Error(`Expected exactly one row from ${context}, got none`);
    return row;
  },
  getDb: () => ({
    select: (_proj?: unknown) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === marketingLeadsTable) return thenable(fakeState.leads);
          if (table === whatsappMessagesTable) return thenable(fakeState.messages);
          if (table === leadMatchCandidatesTable) return thenable(fakeState.candidates);
          return thenable([]);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== leadMatchCandidatesTable) return [];
            fakeState.candidateInsertCalls.push(vals);
            const exists = fakeState.candidates.some(
              (c) => c.marketingLeadId === vals.marketingLeadId && c.clientId === vals.clientId,
            );
            if (exists) return [];
            const row = { id: `cand-${fakeState.nextCandidateId++}`, createdAt: new Date(), ...vals };
            fakeState.candidates.push(row);
            return [row];
          },
        }),
      }),
    }),
    // Supports both call shapes real service.ts code uses: a bare
    // `await db.update(...).set(...).where(...)` (confirmLeadByContactToken's
    // lead/client updates) and `.where(...).returning(...)`
    // (recordAmbiguousLeadCandidates' ambiguous-marking update) — the
    // side effect (pushing to *UpdateCalls) happens exactly once per real
    // call, however it's awaited.
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const apply = () => {
            if (table === marketingLeadsTable) {
              fakeState.leadUpdateCalls.push(values);
              const lead = fakeState.leads[0];
              if (lead && values.attributionConfidence === "ambiguous" && lead.attributionConfidence !== "unknown") {
                // Simulates the `eq(attributionConfidence, 'unknown')` WHERE
                // guard on the ambiguous-marking update: only "succeeds"
                // (returns a row) when the seeded lead's current confidence
                // allows it.
                return [];
              }
              return [{ id: lead?.id ?? "lead-1", ...values }];
            }
            if (table === clientsTable) {
              fakeState.clientUpdateCalls.push({ id: fakeState.leads[0]?.clientId, values });
              return [];
            }
            return [];
          };
          const promise = Promise.resolve().then(apply);
          return {
            returning: async () => apply(),
            then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => promise.then(resolve, reject),
            catch: (reject: (e: unknown) => void) => promise.catch(reject),
          };
        },
      }),
    }),
  }),
}));

const { confirmLeadByContactToken, recordAmbiguousLeadCandidates, listLeadMatchCandidates } = await import(
  "./service"
);

function fakeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: "client-1",
    tenantId: "tenant-1",
    profileId: null,
    customerType: "private",
    fullName: "Mario Rossi",
    companyName: null,
    email: null,
    phone: "393281234567",
    country: null,
    preferredLanguage: null,
    notes: null,
    marketingConsent: false,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    gclid: null,
    landingPage: null,
    referrer: null,
    firstTouchAt: null,
    visitorId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Client;
}

function fakeLead(overrides: Partial<MarketingLead> = {}): Record<string, unknown> {
  return {
    id: "lead-1",
    tenantId: "tenant-1",
    channel: "whatsapp",
    status: "new",
    clientId: null,
    contactToken: "REF-ABCD2345",
    attributionConfidence: "unknown",
    attributionMethod: "none",
    utmSource: "chatgpt.com",
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    gclid: null,
    landingPage: "https://bonolinitransfer.com/",
    referrer: null,
    visitorId: null,
    createdAt: new Date("2026-09-03T02:05:58Z"),
    ...overrides,
  };
}

beforeEach(() => {
  fakeState.leads = [];
  fakeState.messages = [];
  fakeState.candidates = [];
  fakeState.leadUpdateCalls = [];
  fakeState.clientUpdateCalls = [];
  fakeState.candidateInsertCalls = [];
  fakeState.nextCandidateId = 1;
});

describe("confirmLeadByContactToken", () => {
  it("returns linked:false and writes nothing when the text has no recognizable token", async () => {
    const result = await confirmLeadByContactToken("tenant-1", {
      rawText: "Hi, I'd like a transfer from Milan to Tirano",
      client: fakeClient(),
      clientIsNew: true,
    });

    expect(result).toEqual({ linked: false });
    expect(fakeState.leadUpdateCalls).toHaveLength(0);
    expect(fakeState.clientUpdateCalls).toHaveLength(0);
  });

  it("returns linked:false when the token matches no unlinked lead", async () => {
    fakeState.leads = []; // simulates the query (contactToken + clientId IS NULL) finding nothing

    const result = await confirmLeadByContactToken("tenant-1", {
      rawText: "Ref: REF-ABCD2345",
      client: fakeClient(),
      clientIsNew: true,
    });

    expect(result).toEqual({ linked: false });
    expect(fakeState.clientUpdateCalls).toHaveLength(0);
  });

  it("links the lead as CERTAIN via contact_token when the token matches, for a returning client — never touching the client row", async () => {
    fakeState.leads = [fakeLead({ id: "lead-9" })];
    const client = fakeClient({ id: "client-9", utmSource: null });

    const result = await confirmLeadByContactToken("tenant-1", {
      rawText: "Ciao! Ref: REF-ABCD2345",
      client,
      clientIsNew: false, // returning client — the case the founder was explicit about
    });

    expect(result).toEqual({ linked: true, marketingLeadId: "lead-9" });
    expect(fakeState.leadUpdateCalls[0]).toMatchObject({
      clientId: "client-9",
      status: "converted",
      attributionConfidence: "certain",
      attributionMethod: "contact_token",
    });
    // The hard rule: a lead linked to a PRE-EXISTING client must never
    // rewrite that client's acquisition source.
    expect(fakeState.clientUpdateCalls).toHaveLength(0);
  });

  it("backfills only the client's currently-null acquisition fields when the client is brand new", async () => {
    fakeState.leads = [fakeLead({ utmSource: "chatgpt.com", gclid: null, landingPage: "https://bonolinitransfer.com/transfer-milan" })];
    const client = fakeClient({ utmSource: null, gclid: null, landingPage: null });

    await confirmLeadByContactToken("tenant-1", {
      rawText: "REF-ABCD2345",
      client,
      clientIsNew: true,
    });

    expect(fakeState.clientUpdateCalls).toHaveLength(1);
    expect(fakeState.clientUpdateCalls[0]!.values).toEqual({
      utmSource: "chatgpt.com",
      landingPage: "https://bonolinitransfer.com/transfer-milan",
    });
  });

  it("never overwrites a brand-new client's acquisition field that is already set", async () => {
    // Defensive case: shouldn't happen in practice (a truly new client row
    // has no prior data), but the guard must hold regardless.
    fakeState.leads = [fakeLead({ utmSource: "chatgpt.com" })];
    const client = fakeClient({ utmSource: "google" });

    await confirmLeadByContactToken("tenant-1", { rawText: "REF-ABCD2345", client, clientIsNew: true });

    const clientUpdate = fakeState.clientUpdateCalls[0];
    expect(clientUpdate?.values.utmSource).toBeUndefined();
  });

  it("never touches the client row when the lead itself has no attribution data to backfill", async () => {
    fakeState.leads = [fakeLead({ utmSource: null, utmCampaign: null, gclid: null, landingPage: null, referrer: null })];
    const client = fakeClient();

    await confirmLeadByContactToken("tenant-1", { rawText: "REF-ABCD2345", client, clientIsNew: true });

    expect(fakeState.clientUpdateCalls).toHaveLength(0);
  });
});

describe("recordAmbiguousLeadCandidates", () => {
  it("records a candidate and marks the lead ambiguous when a real time-proximity match exists", async () => {
    fakeState.leads = [
      fakeLead({ id: "lead-mario", channel: "whatsapp", createdAt: new Date("2026-08-30T16:01:10Z"), attributionConfidence: "unknown" }),
    ];
    fakeState.messages = [{ clientId: "client-mario", receivedAt: new Date("2026-08-30T16:05:16Z") }];

    const result = await recordAmbiguousLeadCandidates("tenant-1");

    expect(result).toEqual({ candidatesRecorded: 1, leadsMarkedAmbiguous: 1 });
    expect(fakeState.candidateInsertCalls[0]).toMatchObject({
      tenantId: "tenant-1",
      marketingLeadId: "lead-mario",
      clientId: "client-mario",
      method: "whatsapp_time_proximity",
    });
    expect(fakeState.leadUpdateCalls[0]).toMatchObject({ attributionConfidence: "ambiguous" });
  });

  it("never records a candidate for a client whose first message predates the lead (no real correlation)", async () => {
    fakeState.leads = [fakeLead({ id: "lead-dani", createdAt: new Date("2026-08-28T21:05:06Z") })];
    fakeState.messages = [{ clientId: "client-dani", receivedAt: new Date("2026-08-28T20:56:09Z") }]; // before the lead

    const result = await recordAmbiguousLeadCandidates("tenant-1");

    expect(result).toEqual({ candidatesRecorded: 0, leadsMarkedAmbiguous: 0 });
  });

  it("is idempotent — running twice never duplicates a candidate row", async () => {
    fakeState.leads = [fakeLead({ id: "lead-mario", createdAt: new Date("2026-08-30T16:01:10Z") })];
    fakeState.messages = [{ clientId: "client-mario", receivedAt: new Date("2026-08-30T16:05:16Z") }];

    await recordAmbiguousLeadCandidates("tenant-1");
    const second = await recordAmbiguousLeadCandidates("tenant-1");

    expect(second.candidatesRecorded).toBe(0); // onConflictDoNothing — already exists
    expect(fakeState.candidates).toHaveLength(1);
  });
});

describe("listLeadMatchCandidates", () => {
  it("returns the tenant's candidate rows", async () => {
    fakeState.candidates = [{ id: "cand-1", tenantId: "tenant-1" }];
    const rows = await listLeadMatchCandidates("tenant-1");
    expect(rows).toEqual([{ id: "cand-1", tenantId: "tenant-1" }]);
  });
});
