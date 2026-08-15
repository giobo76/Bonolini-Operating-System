import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@bos/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: async () => [{ status: "active", encryptedRefreshToken: "fake-encrypted-token" }],
      }),
    }),
  }),
  marketingConnections: {},
}));

vi.mock("./encryption", () => ({
  decryptToken: () => "fake-refresh-token",
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        on() {}
        async getAccessToken() {
          return { token: "fake-access-token" };
        }
      },
    },
  },
}));

const { normalizeGoogleAdsCustomerId, queryGoogleAds, fetchGoogleAdsWeeklyPerformance } = await import(
  "./google-clients"
);

describe("normalizeGoogleAdsCustomerId", () => {
  it("strips dashes from a dashed customer id", () => {
    expect(normalizeGoogleAdsCustomerId("678-018-7978")).toBe("6780187978");
  });

  it("strips the customers/ prefix and dashes together", () => {
    expect(normalizeGoogleAdsCustomerId("customers/678-018-7978")).toBe("6780187978");
  });

  it("leaves an already-digits-only id unchanged", () => {
    expect(normalizeGoogleAdsCustomerId("6780187978")).toBe("6780187978");
  });

  it("strips dashes from an MCC login-customer-id", () => {
    expect(normalizeGoogleAdsCustomerId("835-695-0609")).toBe("8356950609");
  });
});

describe("queryGoogleAds request body", () => {
  const originalFetch = global.fetch;
  const originalDeveloperToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;

  beforeEach(() => {
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "test-developer-token";
  });

  it("sends query in the body and never sends pageSize (v25 rejects it with PAGE_SIZE_NOT_SUPPORTED)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      await queryGoogleAds("tenant-1", "6780187978", "SELECT customer.id FROM customer");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, options] = fetchMock.mock.calls[0]!;
      const body = JSON.parse((options as RequestInit).body as string);

      expect(body).toHaveProperty("query", "SELECT customer.id FROM customer");
      expect(body).not.toHaveProperty("pageSize");
    } finally {
      global.fetch = originalFetch;
      process.env.GOOGLE_ADS_DEVELOPER_TOKEN = originalDeveloperToken;
    }
  });
});

describe("fetchGoogleAdsWeeklyPerformance GAQL", () => {
  const originalFetch = global.fetch;
  const originalDeveloperToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;

  beforeEach(() => {
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "test-developer-token";
  });

  it("requests metrics.conversions_value, never the invalid metrics.conversion_value (regression: v25 UNRECOGNIZED_FIELD)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      await fetchGoogleAdsWeeklyPerformance("tenant-1", "6780187978");

      const [, options] = fetchMock.mock.calls[0]!;
      const body = JSON.parse((options as RequestInit).body as string) as { query: string };

      expect(body.query).toContain("metrics.conversions_value");
      expect(body.query).not.toMatch(/metrics\.conversion_value(?!s)/);
    } finally {
      global.fetch = originalFetch;
      process.env.GOOGLE_ADS_DEVELOPER_TOKEN = originalDeveloperToken;
    }
  });

  it("parses metrics.conversions_value from the response into totals.conversionValue", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            segments: { date: "2026-08-06" },
            metrics: {
              impressions: "1000",
              clicks: "50",
              cost_micros: "20000000",
              conversions: "2",
              conversions_value: "150.5",
              average_cpc: "400000",
              ctr: "0.05",
            },
          },
          {
            segments: { date: "2026-08-07" },
            metrics: {
              impressions: "500",
              clicks: "20",
              cost_micros: "10000000",
              conversions: "1",
              conversions_value: "75.25",
              average_cpc: "500000",
              ctr: "0.04",
            },
          },
        ],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await fetchGoogleAdsWeeklyPerformance("tenant-1", "6780187978");

      expect(result.totals.conversionValue).toBeCloseTo(225.75);
      expect(result.rows[0]!.conversionValue).toBe(150.5);
      expect(result.rows[1]!.conversionValue).toBe(75.25);
    } finally {
      global.fetch = originalFetch;
      process.env.GOOGLE_ADS_DEVELOPER_TOKEN = originalDeveloperToken;
    }
  });
});
