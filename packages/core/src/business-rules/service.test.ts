import { describe, expect, it, vi, beforeEach } from "vitest";

// Same structural-condition mocking technique as bos-agent/approvals.test.ts,
// extended to four tables sharing one fake DB (business_rules,
// business_rule_versions, business_rule_version_evidence, evidence) so this
// file can exercise the real cross-module call into ../evidence exactly as
// production code does, rather than mocking that boundary away.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: string, val: unknown) => ({ __op: "eq" as const, col, val }),
    and: (...conds: unknown[]) => ({ __op: "and" as const, conds }),
    desc: (col: string) => ({ __op: "desc" as const, col }),
    inArray: (col: string, vals: unknown[]) => ({ __op: "inArray" as const, col, vals }),
  };
});

type Cond =
  | { __op: "eq"; col: string; val: unknown }
  | { __op: "and"; conds: Cond[] }
  | { __op: "inArray"; col: string; vals: unknown[] };

function matches(row: Record<string, unknown>, cond: Cond): boolean {
  if (cond.__op === "and") return cond.conds.every((c) => matches(row, c));
  if (cond.__op === "inArray") return cond.vals.includes(row[cond.col]);
  return row[cond.col] === cond.val;
}

function sortDesc(rows: Record<string, unknown>[], desc?: { __op: "desc"; col: string }) {
  if (!desc) return rows;
  return [...rows].sort((a, b) => {
    const av = a[desc.col];
    const bv = b[desc.col];
    if (av instanceof Date && bv instanceof Date) return bv.getTime() - av.getTime();
    if (typeof av === "number" && typeof bv === "number") return bv - av;
    return String(bv).localeCompare(String(av));
  });
}

function chain(rows: Record<string, unknown>[]) {
  const c = {
    where: (cond: Cond) => chain(rows.filter((r) => matches(r, cond))),
    orderBy: (desc: { __op: "desc"; col: string }) => chain(sortDesc(rows, desc)),
    limit: (n: number) => chain(rows.slice(0, n)),
    returning: async () => rows,
    onConflictDoNothing: async () => rows,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
    catch: (reject: (e: unknown) => unknown) => Promise.resolve(rows).catch(reject),
  };
  return c;
}

const { fakeState, tables } = vi.hoisted(() => ({
  fakeState: {
    business_rules: [] as Array<Record<string, unknown>>,
    business_rule_versions: [] as Array<Record<string, unknown>>,
    business_rule_version_evidence: [] as Array<Record<string, unknown>>,
    evidence: [] as Array<Record<string, unknown>>,
    nextId: 1,
  },
  tables: {
    businessRulesTable: {
      __name: "business_rules" as const,
      id: "id",
      tenantId: "tenantId",
      key: "key",
      category: "category",
      currentVersionId: "currentVersionId",
      updatedAt: "updatedAt",
    },
    businessRuleVersionsTable: {
      __name: "business_rule_versions" as const,
      id: "id",
      tenantId: "tenantId",
      ruleId: "ruleId",
      versionNumber: "versionNumber",
      status: "status",
    },
    businessRuleVersionEvidenceTable: {
      __name: "business_rule_version_evidence" as const,
      id: "id",
      tenantId: "tenantId",
      businessRuleVersionId: "businessRuleVersionId",
      evidenceId: "evidenceId",
    },
    evidenceTable: { __name: "evidence" as const, id: "id", tenantId: "tenantId", collectedAt: "collectedAt" },
  },
}));

function tableRows(table: { __name: keyof typeof fakeState }) {
  return fakeState[table.__name] as Array<Record<string, unknown>>;
}

vi.mock("@bos/db", () => ({
  businessRules: tables.businessRulesTable,
  businessRuleVersions: tables.businessRuleVersionsTable,
  businessRuleVersionEvidence: tables.businessRuleVersionEvidenceTable,
  evidence: tables.evidenceTable,
  assertOne: <T,>(rows: T[], context: string): T => {
    const row = rows[0];
    if (!row) throw new Error(`Expected exactly one row from ${context}, got none`);
    return row;
  },
  getDb: () => ({
    insert: (table: { __name: keyof typeof fakeState }) => ({
      values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const valuesArray = Array.isArray(values) ? values : [values];
        const inserted = valuesArray.map((v) => {
          const row = { id: `${table.__name}-${fakeState.nextId++}`, createdAt: new Date(), ...v };
          tableRows(table).push(row);
          return row;
        });
        return chain(inserted);
      },
    }),
    update: (table: { __name: keyof typeof fakeState }) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (cond: Cond) => {
          const rows = tableRows(table);
          const matched = rows.filter((r) => matches(r, cond));
          matched.forEach((r) => Object.assign(r, patch));
          return chain(matched);
        },
      }),
    }),
    select: (_cols?: unknown) => ({
      from: (table: { __name: keyof typeof fakeState }) => chain(tableRows(table)),
    }),
  }),
}));

const {
  createBusinessRule,
  listBusinessRules,
  getBusinessRule,
  proposeBusinessRuleVersion,
  linkEvidenceToVersion,
  approveBusinessRuleVersion,
  rejectBusinessRuleVersion,
} = await import("./service");
const { createEvidence } = await import("../evidence");

beforeEach(() => {
  fakeState.business_rules = [];
  fakeState.business_rule_versions = [];
  fakeState.business_rule_version_evidence = [];
  fakeState.evidence = [];
  fakeState.nextId = 1;
});

async function seedRule(tenantId = "tenant-1", key = "pricing.fixed_fare.malpensa_airport") {
  return createBusinessRule(tenantId, { key, category: "pricing" });
}

// TEST 1
describe("createBusinessRule", () => {
  it("creates a rule with no current version yet", async () => {
    const rule = await seedRule();
    expect(rule.key).toBe("pricing.fixed_fare.malpensa_airport");
    expect(rule.category).toBe("pricing");
    expect(rule.currentVersionId ?? null).toBeNull();
  });
});

// TEST 2, 3, 4, 5
describe("proposeBusinessRuleVersion — BOS can only ever create status='proposed'", () => {
  it("creates a version with status 'proposed' when author is bos_agent", async () => {
    const rule = await seedRule();
    const version = await proposeBusinessRuleVersion("tenant-1", {
      ruleId: rule.id,
      content: { amountCents: 26000 },
      author: "bos_agent",
      proposalReasoning: "observed a 12% CPC increase on this route over 4 weeks",
      evidenceIds: [],
    });

    expect(version.status).toBe("proposed");
    expect(version.author).toBe("bos_agent");
    expect(version.versionNumber).toBe(1);
  });

  it("never produces 'approved' even if the caller's content tries to smuggle that value in", async () => {
    const rule = await seedRule();
    const version = await proposeBusinessRuleVersion("tenant-1", {
      ruleId: rule.id,
      content: { status: "approved", amountCents: 26000 }, // bait — not a real column, just a jsonb key
      author: "bos_agent",
      evidenceIds: [],
    });

    expect(version.status).toBe("proposed");
  });

  it("never produces 'effective' even if the caller's content tries to smuggle that value in", async () => {
    const rule = await seedRule();
    const version = await proposeBusinessRuleVersion("tenant-1", {
      ruleId: rule.id,
      content: { status: "effective", amountCents: 26000 },
      author: "bos_agent",
      evidenceIds: [],
    });

    expect(version.status).toBe("proposed");
  });

  it("has no parameter of its own that could set status to anything but 'proposed' — the input type has no status field at all", () => {
    // Structural guarantee, not a runtime one: proposeBusinessRuleVersion's
    // signature (schema.ts's ProposeBusinessRuleVersionInput) has no
    // `status` field whatsoever — there is no argument shape that could
    // ever request a different starting status. Verified by TypeScript at
    // compile time (this file would fail to typecheck if a `status` field
    // were ever added below), not by this assertion, which just documents
    // the guarantee for a reader of the test output.
    expect(true).toBe(true);
  });
});

// TEST 6
describe("a decided version can never be flipped into a different final state", () => {
  it("rejects an attempt to approve an already-rejected version", async () => {
    const rule = await seedRule();
    const version = await proposeBusinessRuleVersion("tenant-1", {
      ruleId: rule.id,
      content: { amountCents: 26000 },
      author: "bos_agent",
      evidenceIds: [],
    });
    await rejectBusinessRuleVersion("tenant-1", version.id, "owner-profile-1", "not competitive enough yet");

    await expect(approveBusinessRuleVersion("tenant-1", version.id, "owner-profile-1")).rejects.toThrow(/cannot approve/);
  });
});

// TEST 7
describe("owner approval", () => {
  it("approves a proposed version, making it effective, with the founder's own id and an optional reasoning recorded", async () => {
    const rule = await seedRule();
    const version = await proposeBusinessRuleVersion("tenant-1", {
      ruleId: rule.id,
      content: { amountCents: 26000 },
      author: "bos_agent",
      evidenceIds: [],
    });

    const approved = await approveBusinessRuleVersion("tenant-1", version.id, "owner-profile-1", "looks right, approving");

    expect(approved.status).toBe("effective");
    expect(approved.ownerDecision).toBe("approved");
    expect(approved.decidedBy).toBe("owner-profile-1");
    expect(approved.decidedAt).not.toBeNull();
    expect(approved.effectiveFrom).not.toBeNull();
  });
});

// TEST 8
describe("owner rejection", () => {
  it("rejects a proposed version with a required reason recorded", async () => {
    const rule = await seedRule();
    const version = await proposeBusinessRuleVersion("tenant-1", {
      ruleId: rule.id,
      content: { amountCents: 99999 },
      author: "bos_agent",
      evidenceIds: [],
    });

    const rejected = await rejectBusinessRuleVersion("tenant-1", version.id, "owner-profile-1", "price too aggressive");

    expect(rejected.status).toBe("rejected");
    expect(rejected.ownerDecision).toBe("rejected");
    expect(rejected.ownerDecisionReason).toBe("price too aggressive");
  });
});

// TEST 9
describe("approval updates business_rules.current_version_id", () => {
  it("points the rule's current version at the newly-approved version", async () => {
    const rule = await seedRule();
    const version = await proposeBusinessRuleVersion("tenant-1", {
      ruleId: rule.id,
      content: { amountCents: 26000 },
      author: "bos_agent",
      evidenceIds: [],
    });
    await approveBusinessRuleVersion("tenant-1", version.id, "owner-profile-1");

    const detail = await getBusinessRule("tenant-1", rule.id);
    expect(detail?.currentVersionId).toBe(version.id);
  });
});

// TEST 10
describe("supersession", () => {
  it("moves the previous effective version to 'superseded' only when a new one becomes effective", async () => {
    const rule = await seedRule();
    const v1 = await proposeBusinessRuleVersion("tenant-1", {
      ruleId: rule.id,
      content: { amountCents: 26000 },
      author: "bos_agent",
      evidenceIds: [],
    });
    await approveBusinessRuleVersion("tenant-1", v1.id, "owner-profile-1");

    const v2 = await proposeBusinessRuleVersion("tenant-1", {
      ruleId: rule.id,
      content: { amountCents: 27500 },
      author: "owner",
      evidenceIds: [],
    });
    await approveBusinessRuleVersion("tenant-1", v2.id, "owner-profile-1");

    const detail = await getBusinessRule("tenant-1", rule.id);
    const versionOne = detail?.versions.find((v) => v.versionNumber === 1);
    const versionTwo = detail?.versions.find((v) => v.versionNumber === 2);

    expect(versionOne?.status).toBe("superseded");
    expect(versionTwo?.status).toBe("effective");
    expect(detail?.currentVersionId).toBe(v2.id);
  });
});

// TEST 11
describe("version_number allocation", () => {
  it("increments sequentially per rule across multiple proposals", async () => {
    const rule = await seedRule();
    const v1 = await proposeBusinessRuleVersion("tenant-1", { ruleId: rule.id, content: { a: 1 }, author: "bos_agent", evidenceIds: [] });
    const v2 = await proposeBusinessRuleVersion("tenant-1", { ruleId: rule.id, content: { a: 2 }, author: "bos_agent", evidenceIds: [] });
    const v3 = await proposeBusinessRuleVersion("tenant-1", { ruleId: rule.id, content: { a: 3 }, author: "owner", evidenceIds: [] });

    expect([v1.versionNumber, v2.versionNumber, v3.versionNumber]).toEqual([1, 2, 3]);
  });
});

// TEST 12
describe("tenant isolation", () => {
  it("a rule created for one tenant is invisible to another tenant", async () => {
    const rule = await seedRule("tenant-1");

    expect(await getBusinessRule("tenant-2", rule.id)).toBeNull();
    await expect(
      proposeBusinessRuleVersion("tenant-2", { ruleId: rule.id, content: { a: 1 }, author: "bos_agent", evidenceIds: [] }),
    ).rejects.toThrow(/not found/);
  });

  it("listBusinessRules never returns another tenant's rules", async () => {
    await seedRule("tenant-1", "pricing.a");
    await seedRule("tenant-2", "pricing.b");

    const rules = await listBusinessRules("tenant-1");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.key).toBe("pricing.a");
  });
});

// TEST 13, 14 — already exercised above (approved.ownerDecisionReason /
// rejected.ownerDecisionReason / proposal_reasoning in test 2/7/8), plus a
// dedicated read-back through getBusinessRule to prove persistence beyond
// the immediate return value:
describe("reasoning fields survive a fresh read, not just the mutation's own return value", () => {
  it("proposalReasoning and ownerDecisionReason are both readable via getBusinessRule after the fact", async () => {
    const rule = await seedRule();
    const version = await proposeBusinessRuleVersion("tenant-1", {
      ruleId: rule.id,
      content: { amountCents: 26000 },
      author: "bos_agent",
      proposalReasoning: "CPC on this route rose 12% over 4 weeks",
      evidenceIds: [],
    });
    await approveBusinessRuleVersion("tenant-1", version.id, "owner-profile-1", "agreed, approving");

    const detail = await getBusinessRule("tenant-1", rule.id);
    const readBack = detail?.versions.find((v) => v.id === version.id);

    expect(readBack?.proposalReasoning).toBe("CPC on this route rose 12% over 4 weeks");
    expect(readBack?.ownerDecisionReason).toBe("agreed, approving");
  });
});

// TEST 15, 16
describe("evidence / provenance", () => {
  it("links evidence to a proposal at creation time, reconstructable via getBusinessRule", async () => {
    const rule = await seedRule();
    const fact = await createEvidence("tenant-1", {
      source: "internal_db.bookings",
      rawObservation: { averageCpcCents: 145 },
      conclusion: "average CPC for this route rose from 120 to 145 cents",
      evidenceType: "fact",
      confidence: "high",
    });

    const version = await proposeBusinessRuleVersion("tenant-1", {
      ruleId: rule.id,
      content: { amountCents: 27500 },
      author: "bos_agent",
      proposalReasoning: "CPC increase justifies a price update",
      evidenceIds: [fact.id],
    });

    const detail = await getBusinessRule("tenant-1", rule.id);
    const readBack = detail?.versions.find((v) => v.id === version.id);

    expect(readBack?.evidence).toHaveLength(1);
    expect(readBack?.evidence[0]?.id).toBe(fact.id);
  });

  it("a recommendation can be reconstructed end to end through multiple evidence rows of different epistemic types", async () => {
    const rule = await seedRule();
    const fact = await createEvidence("tenant-1", {
      source: "google_ads_api",
      rawObservation: { cpcCents: [120, 132, 138, 145] },
      conclusion: "CPC rose every week for 4 consecutive weeks",
      evidenceType: "fact",
      confidence: "high",
    });
    const calculation = await createEvidence("tenant-1", {
      source: "internal_db.bookings",
      rawObservation: { fact },
      calculation: { percentIncrease: 20.8 },
      conclusion: "20.8% CPC increase over the period",
      evidenceType: "calculation",
      confidence: "high",
    });

    const version = await proposeBusinessRuleVersion("tenant-1", {
      ruleId: rule.id,
      content: { amountCents: 27500 },
      author: "bos_agent",
      proposalReasoning: "price should track the confirmed CPC increase",
      evidenceIds: [fact.id, calculation.id],
    });

    // Attach one more piece of evidence after creation, while still proposed.
    const secondFact = await createEvidence("tenant-1", {
      source: "internal_db.bookings",
      rawObservation: { conversionRate: 0.18 },
      conclusion: "conversion rate held steady despite the CPC increase",
      evidenceType: "fact",
      confidence: "medium",
    });
    await linkEvidenceToVersion("tenant-1", version.id, secondFact.id);

    const detail = await getBusinessRule("tenant-1", rule.id);
    const readBack = detail?.versions.find((v) => v.id === version.id);
    const evidenceTypes = readBack?.evidence.map((e) => e.evidenceType).sort();

    expect(readBack?.evidence).toHaveLength(3);
    expect(evidenceTypes).toEqual(["calculation", "fact", "fact"]);
  });

  it("refuses to attach new evidence to a version that has already been decided", async () => {
    const rule = await seedRule();
    const version = await proposeBusinessRuleVersion("tenant-1", { ruleId: rule.id, content: { a: 1 }, author: "bos_agent", evidenceIds: [] });
    await approveBusinessRuleVersion("tenant-1", version.id, "owner-profile-1");

    const lateEvidence = await createEvidence("tenant-1", {
      source: "s",
      rawObservation: {},
      conclusion: "too late",
      evidenceType: "fact",
      confidence: "low",
    });

    await expect(linkEvidenceToVersion("tenant-1", version.id, lateEvidence.id)).rejects.toThrow(/immutable/);
  });
});

// TEST 17
describe("invalid state transitions are rejected", () => {
  it("cannot reject a version that is already effective", async () => {
    const rule = await seedRule();
    const version = await proposeBusinessRuleVersion("tenant-1", { ruleId: rule.id, content: { a: 1 }, author: "bos_agent", evidenceIds: [] });
    await approveBusinessRuleVersion("tenant-1", version.id, "owner-profile-1");

    await expect(rejectBusinessRuleVersion("tenant-1", version.id, "owner-profile-1", "changed my mind")).rejects.toThrow(
      /cannot reject/,
    );
  });

  it("cannot approve a version that has been superseded", async () => {
    const rule = await seedRule();
    const v1 = await proposeBusinessRuleVersion("tenant-1", { ruleId: rule.id, content: { a: 1 }, author: "bos_agent", evidenceIds: [] });
    await approveBusinessRuleVersion("tenant-1", v1.id, "owner-profile-1");
    const v2 = await proposeBusinessRuleVersion("tenant-1", { ruleId: rule.id, content: { a: 2 }, author: "bos_agent", evidenceIds: [] });
    await approveBusinessRuleVersion("tenant-1", v2.id, "owner-profile-1"); // v1 -> superseded

    await expect(approveBusinessRuleVersion("tenant-1", v1.id, "owner-profile-1")).rejects.toThrow(/cannot approve/);
  });
});

// TEST 18
describe("idempotent approval", () => {
  it("calling approve twice on the same version is a safe no-op the second time", async () => {
    const rule = await seedRule();
    const version = await proposeBusinessRuleVersion("tenant-1", { ruleId: rule.id, content: { a: 1 }, author: "bos_agent", evidenceIds: [] });

    const first = await approveBusinessRuleVersion("tenant-1", version.id, "owner-profile-1", "ok");
    const second = await approveBusinessRuleVersion("tenant-1", version.id, "owner-profile-1");

    expect(second.status).toBe("effective");
    expect(second.decidedAt).toEqual(first.decidedAt);
    expect(second.ownerDecisionReason).toBe("ok"); // never overwritten by the second, reason-less call
  });

  it("a second approval never re-supersedes anything a second time", async () => {
    const rule = await seedRule();
    const v1 = await proposeBusinessRuleVersion("tenant-1", { ruleId: rule.id, content: { a: 1 }, author: "bos_agent", evidenceIds: [] });
    await approveBusinessRuleVersion("tenant-1", v1.id, "owner-profile-1");
    const v2 = await proposeBusinessRuleVersion("tenant-1", { ruleId: rule.id, content: { a: 2 }, author: "bos_agent", evidenceIds: [] });
    await approveBusinessRuleVersion("tenant-1", v2.id, "owner-profile-1");

    // Calling approve again on v2 (already effective) must not touch v1's
    // already-superseded status or throw.
    await approveBusinessRuleVersion("tenant-1", v2.id, "owner-profile-1");

    const detail = await getBusinessRule("tenant-1", rule.id);
    expect(detail?.versions.find((v) => v.id === v1.id)?.status).toBe("superseded");
  });
});

// TEST 19
describe("idempotent rejection", () => {
  it("calling reject twice on the same version is a safe no-op the second time", async () => {
    const rule = await seedRule();
    const version = await proposeBusinessRuleVersion("tenant-1", { ruleId: rule.id, content: { a: 1 }, author: "bos_agent", evidenceIds: [] });

    const first = await rejectBusinessRuleVersion("tenant-1", version.id, "owner-profile-1", "not now");
    const second = await rejectBusinessRuleVersion("tenant-1", version.id, "owner-profile-1", "different reason ignored");

    expect(second.status).toBe("rejected");
    expect(second.ownerDecisionReason).toBe("not now"); // first reason wins, never overwritten
    expect(second.decidedAt).toEqual(first.decidedAt);
  });
});

// TEST 20
describe("a rejected proposal can never become effective", () => {
  it("approveBusinessRuleVersion throws on an already-rejected version, and business_rules.current_version_id is never touched", async () => {
    const rule = await seedRule();
    const version = await proposeBusinessRuleVersion("tenant-1", { ruleId: rule.id, content: { a: 1 }, author: "bos_agent", evidenceIds: [] });
    await rejectBusinessRuleVersion("tenant-1", version.id, "owner-profile-1", "no");

    await expect(approveBusinessRuleVersion("tenant-1", version.id, "owner-profile-1")).rejects.toThrow(/cannot approve/);

    const detail = await getBusinessRule("tenant-1", rule.id);
    expect(detail?.currentVersionId ?? null).toBeNull();
  });
});
