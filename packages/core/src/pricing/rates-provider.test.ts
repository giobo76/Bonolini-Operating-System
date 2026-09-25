import { describe, expect, it, vi, beforeEach } from "vitest";

// Same structural-condition mocking technique as business-rules/
// service.test.ts, reused as-is: resolvePricingRates is a real integration
// between pricing and business-rules (via getBusinessRuleByKey), so this
// file exercises that real path against one shared fake DB, rather than
// mocking business-rules away.
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

const { createBusinessRule, proposeBusinessRuleVersion, approveBusinessRuleVersion } = await import("../business-rules");
const { resolvePricingRates } = await import("./rates-provider");
const { DEFAULT_PRICING_RATES, pricingRuleKeys } = await import("./schema");

beforeEach(() => {
  fakeState.business_rules = [];
  fakeState.business_rule_versions = [];
  fakeState.business_rule_version_evidence = [];
  fakeState.evidence = [];
  fakeState.nextId = 1;
});

// Seeds one pricing rule with a real, approved, effective version — the
// exact production shape a migration-seeded rule (or a later BOS-proposed
// and founder-approved one) would have.
async function seedEffectiveRule(tenantId: string, key: string, content: Record<string, unknown>) {
  const rule = await createBusinessRule(tenantId, { key, category: "pricing" });
  const version = await proposeBusinessRuleVersion(tenantId, { ruleId: rule.id, content, author: "owner", evidenceIds: [] });
  await approveBusinessRuleVersion(tenantId, version.id, "owner-profile-1");
  return { rule, version };
}

async function seedAllDefaultRules(tenantId: string) {
  await seedEffectiveRule(tenantId, pricingRuleKeys.minimumFare, { minimumFareCents: DEFAULT_PRICING_RATES.minimumFareCents });
  await seedEffectiveRule(tenantId, pricingRuleKeys.tollRate, { ratePerKm: DEFAULT_PRICING_RATES.tollRatePerKm });
  await seedEffectiveRule(tenantId, pricingRuleKeys.distanceRate, DEFAULT_PRICING_RATES.distanceRate);
  await seedEffectiveRule(tenantId, pricingRuleKeys.fixedFareAirport, DEFAULT_PRICING_RATES.fixedFareAirport);
  await seedEffectiveRule(tenantId, pricingRuleKeys.foreignFixedTirano, DEFAULT_PRICING_RATES.foreignFixedTirano);
  await seedEffectiveRule(tenantId, pricingRuleKeys.hospitalWaitingItalian, DEFAULT_PRICING_RATES.hospitalWaitingItalian);
}

const SONDRIO_MALPENSA = {
  italian: { "4": 25000, "5": 27000, "6": 29000, "7": 32000, "8": 35000 },
  foreignUpTo8PassengersCents: 38000,
};

describe("resolvePricingRates — all seven rules present and effective", () => {
  it("resolves rates identical to DEFAULT_PRICING_RATES (plus the Sondrio-Malpensa fare) when every rule is effective, all sourced from business_rule", async () => {
    await seedAllDefaultRules("tenant-1");
    await seedEffectiveRule("tenant-1", pricingRuleKeys.sondrioMalpensa, SONDRIO_MALPENSA);

    const resolution = await resolvePricingRates("tenant-1");

    expect(resolution.rates).toEqual({ ...DEFAULT_PRICING_RATES, sondrioMalpensa: SONDRIO_MALPENSA });
    expect(resolution.usedFallback).toBe(false);
    expect(resolution.provenance).toHaveLength(7);
    expect(resolution.provenance.every((p) => p.source === "business_rule")).toBe(true);
  });

  it("without the Sondrio-Malpensa rule the fare is null (no amount in code) and only that slot is a fallback", async () => {
    await seedAllDefaultRules("tenant-1");

    const resolution = await resolvePricingRates("tenant-1");

    expect(resolution.rates?.sondrioMalpensa).toBeNull();
    expect(resolution.rates).toEqual(DEFAULT_PRICING_RATES);
    const fallbacks = resolution.provenance.filter((p) => p.source === "fallback_default");
    expect(fallbacks.map((p) => p.ruleKey)).toEqual([pricingRuleKeys.sondrioMalpensa]);
  });

  it("an invalid Sondrio-Malpensa rule refuses all rates rather than guessing", async () => {
    await seedAllDefaultRules("tenant-1");
    await seedEffectiveRule("tenant-1", pricingRuleKeys.sondrioMalpensa, { italian: { "4": -1 } });

    const resolution = await resolvePricingRates("tenant-1");

    expect(resolution.rates).toBeNull();
    expect(resolution.invalidReason).toContain("sondrioMalpensa");
  });

  it("resolves a genuinely different price-affecting value when the effective rule content differs from the default", async () => {
    await seedAllDefaultRules("tenant-1");
    // Re-propose and approve a new minimum fare — this rule's rates must
    // reflect the new effective version, not the migration-seeded one.
    const rules = await import("../business-rules");
    const rule = await rules.getBusinessRuleByKey("tenant-1", pricingRuleKeys.minimumFare);
    const newVersion = await proposeBusinessRuleVersion("tenant-1", {
      ruleId: rule!.id,
      content: { minimumFareCents: 8000 },
      author: "owner",
      evidenceIds: [],
    });
    await approveBusinessRuleVersion("tenant-1", newVersion.id, "owner-profile-1");

    const resolution = await resolvePricingRates("tenant-1");
    expect(resolution.rates?.minimumFareCents).toBe(8000);
  });
});

describe("resolvePricingRates — missing rules fall back to DEFAULT_PRICING_RATES, explicitly and loudly", () => {
  it("falls back to the exact default values when no rules exist at all yet (pre-migration state)", async () => {
    const resolution = await resolvePricingRates("tenant-1");

    expect(resolution.rates).toEqual(DEFAULT_PRICING_RATES);
    expect(resolution.usedFallback).toBe(true);
    expect(resolution.provenance.every((p) => p.source === "fallback_default" && p.fallbackReason === "rule_not_found")).toBe(true);
  });

  it("falls back only for the specific missing rule, resolving the rest from their real business rules", async () => {
    await seedEffectiveRule("tenant-1", pricingRuleKeys.minimumFare, { minimumFareCents: DEFAULT_PRICING_RATES.minimumFareCents });
    // Every other rule is deliberately left unseeded.

    const resolution = await resolvePricingRates("tenant-1");

    expect(resolution.rates).toEqual(DEFAULT_PRICING_RATES);
    expect(resolution.usedFallback).toBe(true);
    const minimumFareEntry = resolution.provenance.find((p) => p.ruleKey === pricingRuleKeys.minimumFare);
    const tollRateEntry = resolution.provenance.find((p) => p.ruleKey === pricingRuleKeys.tollRate);
    expect(minimumFareEntry?.source).toBe("business_rule");
    expect(tollRateEntry?.source).toBe("fallback_default");
    expect(tollRateEntry?.fallbackReason).toBe("rule_not_found");
  });

  it("falls back when a rule exists but has no effective version yet (only proposed)", async () => {
    const rule = await createBusinessRule("tenant-1", { key: pricingRuleKeys.minimumFare, category: "pricing" });
    await proposeBusinessRuleVersion("tenant-1", { ruleId: rule.id, content: { minimumFareCents: 7000 }, author: "bos_agent", evidenceIds: [] });
    // Deliberately never approved.

    const resolution = await resolvePricingRates("tenant-1");

    expect(resolution.rates?.minimumFareCents).toBe(DEFAULT_PRICING_RATES.minimumFareCents); // fallback, NOT the proposed 7000
    const entry = resolution.provenance.find((p) => p.ruleKey === pricingRuleKeys.minimumFare);
    expect(entry?.source).toBe("fallback_default");
    expect(entry?.fallbackReason).toBe("no_effective_version");
    expect(entry?.ruleId).toBe(rule.id); // the rule is known, just not yet decided
  });
});

describe("resolvePricingRates — a proposed version never influences pricing; only the effective one does", () => {
  it("a newly-proposed version on top of an already-effective one does not change the resolved rate", async () => {
    await seedAllDefaultRules("tenant-1");
    const rule = await (await import("../business-rules")).getBusinessRuleByKey("tenant-1", pricingRuleKeys.minimumFare);

    // A BOS-proposed change sits alongside the effective version, undecided.
    await proposeBusinessRuleVersion("tenant-1", {
      ruleId: rule!.id,
      content: { minimumFareCents: 12345 },
      author: "bos_agent",
      proposalReasoning: "observed cost increase",
      evidenceIds: [],
    });

    const resolution = await resolvePricingRates("tenant-1");
    expect(resolution.rates?.minimumFareCents).toBe(DEFAULT_PRICING_RATES.minimumFareCents); // unaffected by the pending proposal
  });
});

describe("resolvePricingRates — invalid effective content is a real configuration error, never a silent fallback", () => {
  it("returns rates: null and a clear invalidReason when an effective rule's content fails schema validation", async () => {
    // minimumFareCents must be a positive integer — this content is missing it.
    await seedEffectiveRule("tenant-1", pricingRuleKeys.minimumFare, { wrongField: 123 });

    const resolution = await resolvePricingRates("tenant-1");

    expect(resolution.rates).toBeNull();
    expect(resolution.usedFallback).toBe(false);
    expect(resolution.invalidReason).toContain("minimumFare");
  });

  it("never silently substitutes the default value for an invalid effective rule (that would hide a real configuration error)", async () => {
    await seedEffectiveRule("tenant-1", pricingRuleKeys.tollRate, { ratePerKm: "not-a-number" });

    const resolution = await resolvePricingRates("tenant-1");

    expect(resolution.rates).toBeNull();
  });
});

describe("resolvePricingRates — tenant isolation", () => {
  it("resolves each tenant's own rules independently — one tenant's custom rate never leaks into another's resolution", async () => {
    await seedAllDefaultRules("tenant-1");
    await seedEffectiveRule("tenant-2", pricingRuleKeys.minimumFare, { minimumFareCents: 11111 });

    const tenant1 = await resolvePricingRates("tenant-1");
    const tenant2 = await resolvePricingRates("tenant-2");

    expect(tenant1.rates?.minimumFareCents).toBe(DEFAULT_PRICING_RATES.minimumFareCents);
    expect(tenant2.rates?.minimumFareCents).toBe(11111);
    // tenant-2 only seeded minimumFare — everything else falls back, but
    // that fallback must be tenant-2's own resolution, not tenant-1's.
    expect(tenant2.usedFallback).toBe(true);
  });

  it("a tenant with zero rules never sees another tenant's rule ids in its provenance", async () => {
    const { rule } = await seedEffectiveRule("tenant-1", pricingRuleKeys.minimumFare, {
      minimumFareCents: DEFAULT_PRICING_RATES.minimumFareCents,
    });

    const resolution = await resolvePricingRates("tenant-2");
    const entry = resolution.provenance.find((p) => p.ruleKey === pricingRuleKeys.minimumFare);

    expect(entry?.ruleId).not.toBe(rule.id);
    expect(entry?.source).toBe("fallback_default");
  });
});

describe("resolvePricingRates — provenance identifies exactly which rule/version was used", () => {
  it("provenance carries the real ruleId, versionId, and versionNumber for a business_rule-sourced value", async () => {
    const { rule, version } = await seedEffectiveRule("tenant-1", pricingRuleKeys.minimumFare, {
      minimumFareCents: DEFAULT_PRICING_RATES.minimumFareCents,
    });

    const resolution = await resolvePricingRates("tenant-1");
    const entry = resolution.provenance.find((p) => p.ruleKey === pricingRuleKeys.minimumFare);

    expect(entry?.ruleId).toBe(rule.id);
    expect(entry?.versionId).toBe(version.id);
    expect(entry?.versionNumber).toBe(1);
    expect(entry?.source).toBe("business_rule");
  });
});
