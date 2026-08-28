import { describe, expect, it, vi, beforeEach } from "vitest";

// Same strategy as service.test.ts/ga4-checks.test.ts: @bos/db is fully
// mocked, keyed by table identity. attribution-checks.ts had no test file
// at all before this — added alongside the second (attribution_capture_
// failure) signal so both are covered together.
const { fakeDb, clientsTable } = vi.hoisted(() => {
  return {
    fakeDb: { rows: [] as Array<Record<string, unknown>> },
    clientsTable: { __name: "clients" },
  };
});

vi.mock("@bos/db", () => ({
  clients: clientsTable,
  getDb: () => ({
    select: () => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => Promise.resolve(table === clientsTable ? fakeDb.rows : []),
      }),
    }),
  }),
}));

const { runChecks } = await import("./attribution-checks");

function lead(overrides: Partial<{ gclid: string | null; utmCampaign: string | null; utmSource: string | null; landingPage: string | null }> = {}) {
  return { gclid: null, utmCampaign: null, utmSource: null, landingPage: null, ...overrides };
}

function fill(count: number, factory: (i: number) => ReturnType<typeof lead>) {
  return Array.from({ length: count }, (_, i) => factory(i));
}

describe("attribution-checks", () => {
  beforeEach(() => {
    fakeDb.rows = [];
  });

  it("produces no findings below MIN_LEADS_FOR_CHECK, however skewed the data looks", async () => {
    fakeDb.rows = fill(9, () => lead());

    expect(await runChecks("tenant-1")).toHaveLength(0);
  });

  it("produces no findings when leads are fully attributed", async () => {
    fakeDb.rows = fill(10, () => lead({ gclid: "abc", utmCampaign: "camp", utmSource: "google", landingPage: "/x" }));

    expect(await runChecks("tenant-1")).toHaveLength(0);
  });

  it("fires attribution_untagged_ratio when >=30% of leads have a gclid but no utm tagging", async () => {
    fakeDb.rows = [
      ...fill(4, () => lead({ gclid: "abc" })), // has gclid, missing utm — the untagged case
      ...fill(6, () => lead({ gclid: "abc", utmCampaign: "camp", utmSource: "google" })),
    ];

    const drafts = await runChecks("tenant-1");

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ dedupeKey: "attribution_untagged_ratio:tenant-1", category: "attribution", severity: "medium" });
  });

  it("fires attribution_capture_failure when >=30% of leads have no gclid, utm, or landing page at all — a structurally different signal from untagged_ratio", async () => {
    fakeDb.rows = [
      ...fill(4, () => lead()), // fully blank — the capture-failure case
      ...fill(6, () => lead({ gclid: "abc", utmCampaign: "camp", utmSource: "google", landingPage: "/x" })),
    ];

    const drafts = await runChecks("tenant-1");

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ dedupeKey: "attribution_capture_failure:tenant-1", category: "attribution", severity: "high" });
  });

  it("real Production shape (2026-08-28): 28/28 leads with zero attribution data fires capture_failure only, at 100%", async () => {
    fakeDb.rows = fill(28, () => lead());

    const drafts = await runChecks("tenant-1");

    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.dedupeKey).toBe("attribution_capture_failure:tenant-1");
    expect(drafts[0]!.evidence).toMatchObject({ fullyUnattributedCount: 28, totalLeads: 28, ratio: 1 });
  });

  it("fires both signals independently when both conditions are true at once — they are not mutually exclusive", async () => {
    fakeDb.rows = [
      ...fill(4, () => lead()), // fully blank
      ...fill(4, () => lead({ gclid: "abc" })), // gclid but no utm
      ...fill(2, () => lead({ gclid: "abc", utmCampaign: "camp", utmSource: "google", landingPage: "/x" })),
    ];

    const drafts = await runChecks("tenant-1");

    expect(drafts.map((d) => d.dedupeKey)).toEqual(
      expect.arrayContaining(["attribution_untagged_ratio:tenant-1", "attribution_capture_failure:tenant-1"]),
    );
    expect(drafts).toHaveLength(2);
  });
});
