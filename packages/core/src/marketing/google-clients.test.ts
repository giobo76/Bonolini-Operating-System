import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Hoisted, mutable fake state so individual tests (see "invalid_grant
// detection" below) can control the OAuth2 mock's getAccessToken behavior
// and inspect what got written back to marketing_connections — same
// pattern used elsewhere in this codebase's @bos/db mocks (e.g.
// transfer-requests/service.test.ts) rather than inventing a new one.
const { fakeState } = vi.hoisted(() => ({
  fakeState: {
    connectionStatus: "active" as string,
    // Each captured as { status } — only field this module's update() call
    // ever sets besides updatedAt, which isn't asserted on (timing-only).
    updateCalls: [] as Array<{ status: string }>,
    // Overridable per test; defaults to the pre-existing happy-path
    // behavior so every test written before this one keeps passing
    // unchanged.
    getAccessTokenImpl: async () => ({ token: "fake-access-token" }),
  },
}));

vi.mock("@bos/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: async () => [{ status: fakeState.connectionStatus, encryptedRefreshToken: "fake-encrypted-token" }],
      }),
    }),
    update: () => ({
      set: (values: { status: string }) => ({
        where: async () => {
          fakeState.updateCalls.push({ status: values.status });
        },
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
          return fakeState.getAccessTokenImpl();
        }
      },
    },
  },
}));

const {
  normalizeGoogleAdsCustomerId,
  queryGoogleAds,
  fetchGoogleAdsWeeklyPerformance,
  getGoogleAdsAccessToken,
  assertValidOAuthRedirectUri,
} = await import("./google-clients");

beforeEach(() => {
  fakeState.connectionStatus = "active";
  fakeState.updateCalls = [];
  fakeState.getAccessTokenImpl = async () => ({ token: "fake-access-token" });
});

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

  it("uses the normalized (dashless) customer id in the request URL path, even when given a dashed id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      await queryGoogleAds("tenant-1", "678-018-7978", "SELECT customer.id FROM customer");

      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toContain("/customers/6780187978/");
      expect(url).not.toContain("678-018-7978");
    } finally {
      global.fetch = originalFetch;
      process.env.GOOGLE_ADS_DEVELOPER_TOKEN = originalDeveloperToken;
    }
  });

  // Regression: an API error must be thrown, never swallowed into a
  // successful-looking empty response — the caller (google-ads-checks.ts,
  // via run-check.ts) relies on this to surface a broken connection as an
  // api_error finding instead of silently reporting "no issues found".
  it("throws, rather than swallowing, when the API responds with a non-ok status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}',
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(queryGoogleAds("tenant-1", "6780187978", "SELECT customer.id FROM customer")).rejects.toThrow(
        "Google Ads query failed (400)",
      );
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

  // Regression: the Google Ads REST API serializes its JSON *response* in
  // camelCase (costMicros, conversionsValue, averageCpc) regardless of the
  // snake_case field paths used in the GAQL SELECT clause — confirmed
  // against a real captured response payload (see the shape below, which
  // mirrors it exactly, including which fields come back as strings vs
  // plain numbers). The previous version of this test used a snake_case
  // response mock (cost_micros/conversions_value/average_cpc), which does
  // not represent what Google actually returns and let a real parsing bug
  // (google-clients.ts reading the wrong keys, always getting undefined ->
  // 0) pass unnoticed.
  it("parses the real camelCase response shape into totals (costMicros/conversionsValue/averageCpc)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            customer: { resourceName: "customers/6780187978" },
            segments: { date: "2026-08-16" },
            metrics: {
              impressions: "6",
              clicks: "1",
              costMicros: "2260000",
              conversions: 0,
              conversionsValue: 0,
              averageCpc: 2260000,
              ctr: 0.16666666666666666,
            },
          },
          {
            customer: { resourceName: "customers/6780187978" },
            segments: { date: "2026-08-17" },
            metrics: {
              impressions: "500",
              clicks: "20",
              costMicros: "10000000",
              conversions: 1,
              conversionsValue: 75.25,
              averageCpc: 500000,
              ctr: 0.04,
            },
          },
        ],
        fieldMask: "segments.date,metrics.impressions,metrics.clicks,metrics.costMicros,metrics.conversions,metrics.conversionsValue,metrics.averageCpc,metrics.ctr",
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await fetchGoogleAdsWeeklyPerformance("tenant-1", "6780187978");

      // costMicros = "2260000" -> costCents = round(2260000 / 10000) = 226 -> €2.26
      expect(result.rows[0]!.costMicros).toBe(2260000);
      expect(result.totals.costCents).toBe(226 + 1000); // 226 (row 1) + 1000 (row 2: 10,000,000 / 10000)
      expect((result.totals.costCents / 100).toFixed(2)).toBe("12.26"); // €2.26 + €10.00

      // conversionsValue read correctly (not silently zeroed)
      expect(result.rows[1]!.conversionValue).toBe(75.25);
      expect(result.totals.conversionValue).toBeCloseTo(75.25);

      // averageCpc read correctly (not silently zeroed)
      expect(result.rows[0]!.averageCpcMicros).toBe(2260000);
      expect(result.rows[1]!.averageCpcMicros).toBe(500000);
    } finally {
      global.fetch = originalFetch;
      process.env.GOOGLE_ADS_DEVELOPER_TOKEN = originalDeveloperToken;
    }
  });

  it("regression: a real (non-zero) camelCase cost response must not total to zero", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            segments: { date: "2026-08-10" },
            metrics: {
              impressions: "88",
              clicks: "10",
              costMicros: "16670000",
              conversions: 0,
              conversionsValue: 0,
              averageCpc: 1667000,
              ctr: 0.11363636363636363,
            },
          },
        ],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await fetchGoogleAdsWeeklyPerformance("tenant-1", "6780187978");

      // This is exactly the failure mode of the pre-fix code: reading
      // metrics?.cost_micros against this real response returns undefined,
      // parseNumber(undefined) returns 0, and a real €16.67 of spend
      // silently disappears. Asserting non-zero here fails loudly if the
      // parsing keys ever regress back to snake_case.
      expect(result.totals.costCents).not.toBe(0);
      expect(result.totals.costCents).toBe(1667);
    } finally {
      global.fetch = originalFetch;
      process.env.GOOGLE_ADS_DEVELOPER_TOKEN = originalDeveloperToken;
    }
  });
});

describe("invalid_grant detection", () => {
  // Regression for the gap found auditing a real invalid_grant failure: a
  // comment here previously promised a "catch-and-mark-needs-reauth
  // pattern in run-check.ts" that never actually existed anywhere in the
  // codebase — connections stayed "active" in the DB forever regardless of
  // whether Google still honored the refresh token.
  it("marks the connection needs_reauth and throws a clear error when Google's token endpoint returns invalid_grant", async () => {
    fakeState.getAccessTokenImpl = async () => {
      throw Object.assign(new Error("invalid_grant"), {
        response: { data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } },
      });
    };

    await expect(getGoogleAdsAccessToken("tenant-1")).rejects.toThrow(/needs reauthorization \(invalid_grant\)/);

    expect(fakeState.updateCalls).toEqual([{ status: "needs_reauth" }]);
  });

  it("does not mark the connection needs_reauth for an unrelated/transient error (e.g. network failure)", async () => {
    fakeState.getAccessTokenImpl = async () => {
      throw new Error("network error: ECONNRESET");
    };

    await expect(getGoogleAdsAccessToken("tenant-1")).rejects.toThrow("network error: ECONNRESET");

    expect(fakeState.updateCalls).toEqual([]);
  });

  it("does not call getAccessToken again (no needs_reauth write) when the token is valid", async () => {
    await expect(getGoogleAdsAccessToken("tenant-1")).resolves.toBe("fake-access-token");

    expect(fakeState.updateCalls).toEqual([]);
  });
});

describe("assertValidOAuthRedirectUri", () => {
  // Regression for a real production incident: Google rejected reconnect
  // attempts with "Error 400: invalid_request" because the Vercel
  // Production environment's GOOGLE_OAUTH_REDIRECT_URI was left set to the
  // local dev value (http://localhost:3001/...) instead of the real
  // deployed origin. VERCEL_ENV is set automatically by Vercel itself
  // (production/preview/development) and is never set for local `next dev`,
  // so it's what distinguishes "this is genuinely the Production
  // deployment" from local/preview without adding any new configuration.
  const originalVercelEnv = process.env.VERCEL_ENV;

  afterEach(() => {
    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = originalVercelEnv;
    }
  });

  it("throws when GOOGLE_OAUTH_REDIRECT_URI is unset", () => {
    expect(() => assertValidOAuthRedirectUri(undefined)).toThrow("GOOGLE_OAUTH_REDIRECT_URI is not set.");
  });

  it("throws when running as the real Vercel Production deployment but the redirect URI still points at localhost", () => {
    process.env.VERCEL_ENV = "production";

    expect(() => assertValidOAuthRedirectUri("http://localhost:3001/api/marketing/oauth/callback")).toThrow(
      /Production environment/,
    );
  });

  it("allows a localhost redirect URI outside of the real Production deployment (local dev, preview, CI)", () => {
    delete process.env.VERCEL_ENV;
    expect(assertValidOAuthRedirectUri("http://localhost:3001/api/marketing/oauth/callback")).toBe(
      "http://localhost:3001/api/marketing/oauth/callback",
    );

    process.env.VERCEL_ENV = "preview";
    expect(assertValidOAuthRedirectUri("http://localhost:3001/api/marketing/oauth/callback")).toBe(
      "http://localhost:3001/api/marketing/oauth/callback",
    );
  });

  it("allows the real production origin in the real Production deployment", () => {
    process.env.VERCEL_ENV = "production";

    const url = "https://bonolini-operating-system-transfer.vercel.app/api/marketing/oauth/callback";
    expect(assertValidOAuthRedirectUri(url)).toBe(url);
  });
});
