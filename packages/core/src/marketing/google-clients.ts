import { google } from "googleapis";
import { eq } from "drizzle-orm";
import { getDb, marketingConnections } from "@bos/db";
import { decryptToken } from "./encryption";

// UNVERIFIED AGAINST A LIVE GOOGLE ACCOUNT: this file was written against
// documented Google API shapes, not tested against a real connection — no
// Node runtime was available while building it. Expect to debug real
// issues (exact response shapes, quota errors, token edge cases) the first
// time this actually runs. See packages/core/src/marketing/README.md.

async function getOAuth2Client(tenantId: string) {
  const db = getDb();
  const [connection] = await db
    .select()
    .from(marketingConnections)
    .where(eq(marketingConnections.tenantId, tenantId));

  if (!connection || connection.status !== "active") {
    throw new Error("No active Google connection for this tenant — connect one at /marketing/connections");
  }

  const refreshToken = decryptToken(connection.encryptedRefreshToken);

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  // If Google reports the refresh token itself is invalid (revoked access,
  // expired), flag the connection so /marketing/connections can prompt a
  // reconnect instead of failing silently on every check run.
  oauth2Client.on("tokens", () => {
    // Access token refreshed successfully — no action needed, this
    // listener exists so a future invalid_grant handler has a clear place
    // to live (see the catch-and-mark-needs-reauth pattern in run-check.ts).
  });

  return oauth2Client;
}

async function getAccessToken(oauth2Client: InstanceType<typeof google.auth.OAuth2>) {
  const tokenResponse = await oauth2Client.getAccessToken();
  const token = typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;

  if (!token) {
    throw new Error("Unable to obtain Google access token.");
  }

  return token;
}

export async function getAnalyticsDataClient(tenantId: string) {
  const auth = await getOAuth2Client(tenantId);
  return google.analyticsdata({ version: "v1beta", auth });
}

export async function getTagManagerClient(tenantId: string) {
  const auth = await getOAuth2Client(tenantId);
  return google.tagmanager({ version: "v2", auth });
}

export async function getSearchConsoleClient(tenantId: string) {
  const auth = await getOAuth2Client(tenantId);
  return google.searchconsole({ version: "v1", auth });
}

export async function getGoogleAdsAccessToken(tenantId: string) {
  const auth = await getOAuth2Client(tenantId);
  return getAccessToken(auth);
}

function normalizeGoogleAdsCustomerId(externalId: string) {
  return externalId.replace(/^customers\//, "").trim();
}

export async function queryGoogleAds(tenantId: string, customerId: string, query: string) {
  const normalizedCustomerId = normalizeGoogleAdsCustomerId(customerId);
  const accessToken = await getGoogleAdsAccessToken(tenantId);
  const url = `https://googleads.googleapis.com/v14/customers/${encodeURIComponent(normalizedCustomerId)}/googleAds:search`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, pageSize: 1000 }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Google Ads query failed (${response.status}): ${message}`);
  }

  return response.json() as Promise<{ results: Array<Record<string, unknown>>; nextPageToken?: string }>;
}

interface GoogleAdsPerformanceRow {
  date: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
  conversionValue: number;
  averageCpcMicros: number;
  ctr: number;
}

export interface GoogleAdsPerformanceSummary {
  customerId: string;
  dateRange: string;
  totals: {
    impressions: number;
    clicks: number;
    costCents: number;
    conversions: number;
    conversionValue: number;
    averageCpc: number;
    ctr: number;
  };
  rows: GoogleAdsPerformanceRow[];
}

function parseNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  return 0;
}

export async function fetchGoogleAdsWeeklyPerformance(tenantId: string, customerId: string) {
  const now = new Date();
  const endDate = now.toISOString().slice(0, 10);
  const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const query = `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversion_value, metrics.average_cpc, metrics.ctr FROM customer WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' ORDER BY segments.date`;

  const body = await queryGoogleAds(tenantId, customerId, query);
  const rows = Array.isArray(body.results)
    ? body.results.map((result) => {
        const segments = result.segments as Record<string, unknown> | undefined;
        const metrics = result.metrics as Record<string, unknown> | undefined;

        return {
          date: typeof segments?.date === "string" ? segments.date : "",
          impressions: parseNumber(metrics?.impressions),
          clicks: parseNumber(metrics?.clicks),
          costMicros: parseNumber(metrics?.cost_micros),
          conversions: parseNumber(metrics?.conversions),
          conversionValue: parseNumber(metrics?.conversion_value),
          averageCpcMicros: parseNumber(metrics?.average_cpc),
          ctr: parseNumber(metrics?.ctr),
        };
      })
    : [];

  const totals = rows.reduce(
    (acc, row) => {
      acc.impressions += row.impressions;
      acc.clicks += row.clicks;
      acc.costCents += Math.round(row.costMicros / 10000);
      acc.conversions += row.conversions;
      acc.conversionValue += row.conversionValue;
      acc.averageCpc += row.averageCpcMicros;
      acc.ctr += row.ctr;
      return acc;
    },
    {
      impressions: 0,
      clicks: 0,
      costCents: 0,
      conversions: 0,
      conversionValue: 0,
      averageCpc: 0,
      ctr: 0,
    },
  );

  return {
    customerId: normalizeGoogleAdsCustomerId(customerId),
    dateRange: `${startDate}..${endDate}`,
    totals: {
      impressions: totals.impressions,
      clicks: totals.clicks,
      costCents: totals.costCents,
      conversions: totals.conversions,
      conversionValue: totals.conversionValue,
      averageCpc: rows.length ? totals.averageCpc / rows.length / 1000000 : 0,
      ctr: rows.length ? totals.ctr / rows.length : 0,
    },
    rows,
  };
}

// The GTM public container ID (GTM-XXXXXXX, what's visible on the site and
// what /marketing/connections asks for) is not the same as the internal
// accounts/{accountId}/containers/{containerId} path the Tag Manager API
// actually needs. Resolve it by listing accessible accounts/containers and
// matching on publicId, so the UI doesn't have to ask for the internal path.
export async function resolveGtmContainer(tenantId: string, publicId: string) {
  const tagmanager = await getTagManagerClient(tenantId);
  const accounts = await tagmanager.accounts.list();

  for (const account of accounts.data.account ?? []) {
    if (!account.path) continue;
    const containers = await tagmanager.accounts.containers.list({ parent: account.path });
    const match = containers.data.container?.find((c) => c.publicId === publicId);
    if (match?.path && match.containerId) {
      return { tagmanager, path: match.path, containerId: match.containerId };
    }
  }

  throw new Error(
    `GTM container ${publicId} was not found in the connected Google account — check the ID at /marketing/connections`,
  );
}
