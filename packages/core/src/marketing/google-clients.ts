import { google } from "googleapis";
import { eq } from "drizzle-orm";
import { getDb, marketingConnections } from "@bos/db";
import { decryptToken } from "./encryption";

// UNVERIFIED AGAINST A LIVE GOOGLE ACCOUNT: this file was written against
// documented Google API shapes, not tested against a real connection — no
// Node runtime was available while building it. Expect to debug real
// issues (exact response shapes, quota errors, token edge cases) the first
// time this actually runs. See packages/core/src/marketing/README.md.

// The googleapis/google-auth-library client surfaces a failed token refresh
// as a GaxiosError whose response body is Google's OAuth2 error JSON
// ({ error: "invalid_grant", error_description: "..." }) — never a typed
// error class, so this checks the same two places googleapis' own error
// normalization does (response.data.error, falling back to .message for
// older library versions that stringify it into the thrown Error instead).
// invalid_grant specifically means the refresh token itself is dead (user
// revoked access, Google auto-expired it, or — the most likely cause for a
// Testing-status OAuth client — Google's 7-day refresh-token expiry for
// unverified apps) — never a transient network/quota error, so this is
// safe to treat as "this connection needs a human to reconnect," not
// retried.
function isInvalidGrantError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const withResponse = error as { response?: { data?: { error?: unknown } } };
  if (withResponse.response?.data?.error === "invalid_grant") return true;
  const withMessage = error as { message?: unknown };
  return typeof withMessage.message === "string" && withMessage.message.includes("invalid_grant");
}

// Previously promised by a comment here ("see the catch-and-mark-needs-reauth
// pattern in run-check.ts") but never actually implemented anywhere —
// verified by search, not assumed: run-check.ts only ever mentions
// needs_reauth inside a recommended-action string shown to the admin, no
// code path ever wrote it. The connection's DB status stayed "active"
// forever regardless of whether Google still honored the refresh token,
// so every check run kept hitting the same dead token and reporting a
// generic, unexplained api_error finding instead of a clear "reconnect"
// signal. This is the fix for that gap — it does not and cannot fix an
// actual expired/revoked refresh token itself, which only a real
// browser-based re-authorization at /marketing/connections can do.
async function markConnectionNeedsReauth(tenantId: string): Promise<void> {
  const db = getDb();
  await db
    .update(marketingConnections)
    .set({ status: "needs_reauth", updatedAt: new Date() })
    .where(eq(marketingConnections.tenantId, tenantId));
}

// GOOGLE_OAUTH_REDIRECT_URI must be pre-registered, byte-for-byte, in the
// Google Cloud OAuth client's "Authorized redirect URIs" list — Google
// rejects any mismatch, so this can never be derived dynamically from
// request headers (that would also mean trusting an attacker-controllable
// Host header). It has to stay a fixed env var, scoped per Vercel
// environment (Production vs local .env.local).
//
// The only real failure mode is that env var being set wrong for the
// environment it's actually running in: the Production Vercel env var left
// pointing at the local dev value (http://localhost:3001/...), so Google
// rejected the request with "Error 400: invalid_request" before it ever
// reached this app. VERCEL_ENV is set automatically by Vercel on every
// deploy (never set for local `next dev`), so it reliably distinguishes
// "really running as the Production deployment" from local/preview, with
// no new configuration required.
export function assertValidOAuthRedirectUri(redirectUri: string | undefined): string {
  if (!redirectUri) {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI is not set.");
  }

  if (process.env.VERCEL_ENV === "production" && redirectUri.includes("localhost")) {
    throw new Error(
      "GOOGLE_OAUTH_REDIRECT_URI is set to a localhost value in the Production environment — fix it in Vercel project settings before retrying.",
    );
  }

  return redirectUri;
}

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

  // Eagerly validate the refresh token here, once, uniformly for every
  // integration that goes through this function (GA4/GTM/Search
  // Console/Ads) — the googleapis client libraries otherwise only refresh
  // lazily, deep inside the first real API call each one makes, where an
  // invalid_grant failure would surface far from here (a different error
  // shape per library) and never get classified or recorded. Validating
  // eagerly, in one place, means every caller fails the same clear way and
  // the connection is flagged for reconnect instead of failing silently
  // and repeatedly on every future check run.
  try {
    await oauth2Client.getAccessToken();
  } catch (error) {
    if (isInvalidGrantError(error)) {
      await markConnectionNeedsReauth(tenantId);
      throw new Error(
        `Google connection for tenant ${tenantId} needs reauthorization (invalid_grant) — reconnect at /marketing/connections`,
      );
    }
    throw error;
  }

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

// Exported for unit testing — Google Ads API requires a digits-only
// customer ID (both in the URL path and in the login-customer-id header),
// but resource IDs and the MCC env var are commonly written/copied with
// dashes (Google's own dashboard displays them that way).
export function normalizeGoogleAdsCustomerId(externalId: string) {
  return externalId.replace(/^customers\//, "").replace(/-/g, "").trim();
}

export async function queryGoogleAds(tenantId: string, customerId: string, query: string) {
  const normalizedCustomerId = normalizeGoogleAdsCustomerId(customerId);
  const accessToken = await getGoogleAdsAccessToken(tenantId);
  // Use the configured developer token (required by the Ads API) and
  // optional login-customer-id for MCC contexts. The developer token must
  // be supplied via env var `GOOGLE_ADS_DEVELOPER_TOKEN`.
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) {
    throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN is not set — set it in your environment before calling the Google Ads API");
  }

  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;

  const url = `https://googleads.googleapis.com/v25/customers/${encodeURIComponent(normalizedCustomerId)}/googleAds:search`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "developer-token": developerToken,
  };

  if (loginCustomerId && loginCustomerId.trim()) {
    headers["login-customer-id"] = normalizeGoogleAdsCustomerId(loginCustomerId);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
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
  const query = `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.average_cpc, metrics.ctr FROM customer WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' ORDER BY segments.date`;

  const body = await queryGoogleAds(tenantId, customerId, query);
  const rows = Array.isArray(body.results)
    ? body.results.map((result) => {
        const segments = result.segments as Record<string, unknown> | undefined;
        const metrics = result.metrics as Record<string, unknown> | undefined;

        return {
          date: typeof segments?.date === "string" ? segments.date : "",
          impressions: parseNumber(metrics?.impressions),
          clicks: parseNumber(metrics?.clicks),
          // The GAQL SELECT clause (below) uses the query field paths
          // (snake_case: cost_micros, conversions_value, average_cpc), but
          // the Google Ads REST API serializes its JSON *response* in
          // camelCase (costMicros, conversionsValue, averageCpc) — confirmed
          // against a real response payload. Reading the snake_case names
          // here always read undefined, silently turning real spend/
          // conversion-value/CPC data into 0 via parseNumber. Multi-word
          // fields only — impressions/clicks/conversions/ctr are single
          // words and read the same under either convention, which is why
          // this went unnoticed.
          costMicros: parseNumber(metrics?.costMicros),
          conversions: parseNumber(metrics?.conversions),
          conversionValue: parseNumber(metrics?.conversionsValue),
          averageCpcMicros: parseNumber(metrics?.averageCpc),
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

// Per-campaign metrics for one date window — shared shape for both the
// "recent" and "previous" comparison windows fetchGoogleAdsCampaignComparison
// builds below. Field names/parsing mirror fetchGoogleAdsWeeklyPerformance
// exactly (camelCase response keys, parseNumber for the same "field omitted
// when zero" behavior confirmed against a real response — see below).
interface GoogleAdsCampaignWindowRow {
  campaignId: string;
  campaignName: string;
  campaignStatus: string;
  budgetMicros: number;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
  conversionValue: number;
  averageCpcMicros: number;
  ctr: number;
}

function parseCampaignRow(result: Record<string, unknown>): GoogleAdsCampaignWindowRow {
  const campaign = result.campaign as Record<string, unknown> | undefined;
  const budget = result.campaignBudget as Record<string, unknown> | undefined;
  const metrics = result.metrics as Record<string, unknown> | undefined;

  return {
    campaignId: typeof campaign?.id === "string" ? campaign.id : "",
    campaignName: typeof campaign?.name === "string" ? campaign.name : "",
    campaignStatus: typeof campaign?.status === "string" ? campaign.status : "",
    budgetMicros: parseNumber(budget?.amountMicros),
    impressions: parseNumber(metrics?.impressions),
    clicks: parseNumber(metrics?.clicks),
    costMicros: parseNumber(metrics?.costMicros),
    conversions: parseNumber(metrics?.conversions),
    conversionValue: parseNumber(metrics?.conversionsValue),
    // Confirmed against a real response (verified live against Production,
    // 2026-08-27): metrics.ctr and metrics.averageCpc are OMITTED entirely
    // from the response — not present as 0 — for any campaign with zero
    // clicks/impressions in the window, same "field absent, not zero"
    // behavior already documented for fetchGoogleAdsWeeklyPerformance.
    // parseNumber already treats a missing field as 0, which is correct here.
    averageCpcMicros: parseNumber(metrics?.averageCpc),
    ctr: parseNumber(metrics?.ctr),
  };
}

async function fetchCampaignWindow(
  tenantId: string,
  customerId: string,
  startDate: string,
  endDate: string,
): Promise<Map<string, GoogleAdsCampaignWindowRow>> {
  const query =
    "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, " +
    "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, " +
    "metrics.conversions_value, metrics.average_cpc, metrics.ctr " +
    `FROM campaign WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'`;

  const body = await queryGoogleAds(tenantId, customerId, query);
  const rows = Array.isArray(body.results) ? body.results.map(parseCampaignRow) : [];
  return new Map(rows.filter((r) => r.campaignId).map((r) => [r.campaignId, r]));
}

export interface GoogleAdsCampaignComparisonRow {
  campaignId: string;
  campaignName: string;
  campaignStatus: string;
  budgetMicros: number;
  recentCostCents: number;
  recentConversions: number;
  recentConversionValue: number;
  recentClicks: number;
  recentImpressions: number;
  recentAverageCpc: number;
  previousCostCents: number;
  previousConversions: number;
  previousClicks: number;
  previousImpressions: number;
  previousAverageCpc: number;
}

// Two comparable, contiguous, non-overlapping 7-day windows — same
// discipline as ga4-checks.ts's RECENT_RANGE/PREVIOUS_RANGE (comparing
// windows of different lengths silently inflates whatever percentage
// change gets computed). GAQL's reporting API aggregates metrics over the
// whole WHERE date range into one row per campaign when segments.date isn't
// itself selected — two separate queries are required to get two separate
// per-campaign totals, not one query with a wider range.
export async function fetchGoogleAdsCampaignComparison(
  tenantId: string,
  customerId: string,
): Promise<GoogleAdsCampaignComparisonRow[]> {
  const now = new Date();
  const dateOffset = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const recentEnd = dateOffset(0);
  const recentStart = dateOffset(6);
  const previousEnd = dateOffset(7);
  const previousStart = dateOffset(13);

  const [recentMap, previousMap] = await Promise.all([
    fetchCampaignWindow(tenantId, customerId, recentStart, recentEnd),
    fetchCampaignWindow(tenantId, customerId, previousStart, previousEnd),
  ]);

  const campaignIds = new Set([...recentMap.keys(), ...previousMap.keys()]);
  const rows: GoogleAdsCampaignComparisonRow[] = [];

  for (const campaignId of campaignIds) {
    const recent = recentMap.get(campaignId);
    const previous = previousMap.get(campaignId);
    const meta = recent ?? previous!;

    rows.push({
      campaignId,
      campaignName: meta.campaignName,
      campaignStatus: meta.campaignStatus,
      budgetMicros: meta.budgetMicros,
      recentCostCents: Math.round((recent?.costMicros ?? 0) / 10000),
      recentConversions: recent?.conversions ?? 0,
      recentConversionValue: recent?.conversionValue ?? 0,
      recentClicks: recent?.clicks ?? 0,
      recentImpressions: recent?.impressions ?? 0,
      recentAverageCpc: (recent?.averageCpcMicros ?? 0) / 1000000,
      previousCostCents: Math.round((previous?.costMicros ?? 0) / 10000),
      previousConversions: previous?.conversions ?? 0,
      previousClicks: previous?.clicks ?? 0,
      previousImpressions: previous?.impressions ?? 0,
      previousAverageCpc: (previous?.averageCpcMicros ?? 0) / 1000000,
    });
  }

  return rows;
}

// Per-search-term data for Search Term Intelligence (checks/google-ads-
// search-term-checks.ts). Fields confirmed against a real read-only GAQL
// call to Production (2026-08-28):
// - `ad_group_criterion` (needed for match type / matched keyword text)
//   cannot be selected together with `search_term_view` in the same query —
//   the API rejects it with PROHIBITED_RESOURCE_TYPE_IN_SELECT_CLAUSE. There
//   is no join that recovers "which keyword this term matched" at the GAQL
//   level; only search_term_view.status (ADDED/EXCLUDED/NONE) tells us
//   whether Google Ads itself already treats the term as a keyword or a
//   negative — that's the only "already handled" signal available.
// - metrics.ctr / metrics.average_cpc follow the same "field omitted, not
//   zero" behavior already documented elsewhere in this file.
// - metrics.conversions can be fractional (e.g. 0.833334) — Google Ads
//   attributes partial/assisted conversions to a query; treat it as a real
//   number throughout, never round or coerce to an integer.
export type GoogleAdsSearchTermStatus = "ADDED" | "EXCLUDED" | "NONE";

export interface GoogleAdsSearchTermRow {
  campaignId: string;
  campaignName: string;
  searchTerm: string;
  normalizedSearchTerm: string;
  status: GoogleAdsSearchTermStatus;
  costCents: number;
  clicks: number;
  impressions: number;
  conversions: number;
  conversionValue: number;
  ctr: number;
  averageCpc: number;
}

export function normalizeSearchTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, " ");
}

// Tie-break when the same (campaign, normalized search term) appears under
// more than one ad group with a different status — doesn't happen in the
// verified real account, but EXCLUDED must win if it ever does: recommending
// a negative-keyword review, or claiming an opportunity, on a term already
// excluded somewhere in the campaign would be actively wrong.
const SEARCH_TERM_STATUS_PRECEDENCE: Record<GoogleAdsSearchTermStatus, number> = {
  EXCLUDED: 2,
  ADDED: 1,
  NONE: 0,
};

function parseSearchTermRow(result: Record<string, unknown>) {
  const campaign = result.campaign as Record<string, unknown> | undefined;
  const metrics = result.metrics as Record<string, unknown> | undefined;
  const searchTermView = result.searchTermView as Record<string, unknown> | undefined;

  const searchTerm = typeof searchTermView?.searchTerm === "string" ? searchTermView.searchTerm : "";
  const status = typeof searchTermView?.status === "string" ? searchTermView.status : "NONE";

  return {
    campaignId: typeof campaign?.id === "string" ? campaign.id : "",
    campaignName: typeof campaign?.name === "string" ? campaign.name : "",
    searchTerm,
    normalizedSearchTerm: normalizeSearchTerm(searchTerm),
    status: (status === "ADDED" || status === "EXCLUDED" ? status : "NONE") as GoogleAdsSearchTermStatus,
    costMicros: parseNumber(metrics?.costMicros),
    clicks: parseNumber(metrics?.clicks),
    impressions: parseNumber(metrics?.impressions),
    conversions: parseNumber(metrics?.conversions),
    conversionValue: parseNumber(metrics?.conversionsValue),
    ctr: parseNumber(metrics?.ctr),
    averageCpc: parseNumber(metrics?.averageCpc),
  };
}

// 30-day window, not 7 — confirmed against Production (2026-08-28) that
// weekly search-term volume is too sparse to classify reliably (28 terms/7
// days vs 132/30 days for this account, with only 6 converting terms in the
// last 365 days total). A 7-day window would starve the "insufficient data"
// bucket of almost everything real. Flagged to the founder as the window
// choice; not an invented numeric threshold, just the lookback length.
export async function fetchGoogleAdsSearchTerms(
  tenantId: string,
  customerId: string,
): Promise<GoogleAdsSearchTermRow[]> {
  const query =
    "SELECT search_term_view.search_term, search_term_view.status, campaign.id, campaign.name, " +
    "metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions, " +
    "metrics.conversions_value, metrics.ctr, metrics.average_cpc " +
    "FROM search_term_view WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC";

  const body = await queryGoogleAds(tenantId, customerId, query);
  const rawRows = Array.isArray(body.results) ? body.results.map(parseSearchTermRow) : [];

  // Aggregate by (campaignId, normalizedSearchTerm) — the dedupeKey grain
  // the founder specified omits ad group, and the same term can legitimately
  // appear under more than one ad group within a campaign.
  const aggregated = new Map<string, GoogleAdsSearchTermRow>();
  for (const row of rawRows) {
    if (!row.campaignId || !row.normalizedSearchTerm) continue;
    const key = `${row.campaignId}:${row.normalizedSearchTerm}`;
    const existing = aggregated.get(key);
    if (!existing) {
      aggregated.set(key, {
        campaignId: row.campaignId,
        campaignName: row.campaignName,
        searchTerm: row.searchTerm,
        normalizedSearchTerm: row.normalizedSearchTerm,
        status: row.status,
        costCents: Math.round(row.costMicros / 10000),
        clicks: row.clicks,
        impressions: row.impressions,
        conversions: row.conversions,
        conversionValue: row.conversionValue,
        ctr: row.ctr,
        averageCpc: row.averageCpc,
      });
      continue;
    }

    existing.costCents += Math.round(row.costMicros / 10000);
    existing.clicks += row.clicks;
    existing.impressions += row.impressions;
    existing.conversions += row.conversions;
    existing.conversionValue += row.conversionValue;
    if (SEARCH_TERM_STATUS_PRECEDENCE[row.status] > SEARCH_TERM_STATUS_PRECEDENCE[existing.status]) {
      existing.status = row.status;
    }
  }

  return Array.from(aggregated.values());
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
