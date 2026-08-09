import { getSearchConsoleClient, getAnalyticsDataClient, queryGoogleAds } from "./google-clients";

export interface MetricRow {
  date: string;
  impressions: number;
  clicks: number;
  ctr: number;
  conversions: number;
  costCents: number;
  conversionValue: number;
  averageCpc: number;
  position: number;
  sessions: number;
  users: number;
  engagedSessions: number;
  averageSessionDuration: number;
}

export interface DatasetTotals {
  impressions: number;
  clicks: number;
  ctr: number;
  conversions: number;
  costCents: number;
  conversionValue: number;
  averageCpc: number;
  sessions: number;
  users: number;
  engagedSessions: number;
  averageSessionDuration: number;
  position: number;
}

export interface DatasetSummary {
  dateRange: string;
  totals: DatasetTotals;
  rows: MetricRow[];
}

export type AnomalySeverity = "low" | "medium" | "high";

export interface Anomaly {
  title: string;
  description: string;
  severity: AnomalySeverity;
  category: "ga4" | "search_console" | "google_ads" | "cross_channel";
  evidence: Record<string, unknown>;
}

export interface Recommendation {
  title: string;
  action: string;
  rationale: string;
  category: "ga4" | "search_console" | "google_ads" | "cross_channel";
}

export interface MarketingAnalysisResult {
  ga4: DatasetSummary | null;
  searchConsole: DatasetSummary | null;
  googleAds: DatasetSummary | null;
  anomalies: Anomaly[];
  recommendations: Recommendation[];
  generatedAt: string;
}

function parseNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  return 0;
}

function dateRangeLabel(startDate: string, endDate: string) {
  return `${startDate}..${endDate}`;
}

function buildTotals(rows: MetricRow[]): DatasetTotals {
  return rows.reduce(
    (acc, row) => {
      acc.impressions += row.impressions;
      acc.clicks += row.clicks;
      acc.ctr += row.ctr;
      acc.conversions += row.conversions;
      acc.costCents += row.costCents ?? 0;
      acc.conversionValue += row.conversionValue ?? 0;
      acc.averageCpc += row.averageCpc ?? 0;
      acc.sessions += row.sessions ?? 0;
      acc.users += row.users ?? 0;
      acc.engagedSessions += row.engagedSessions ?? 0;
      acc.averageSessionDuration += row.averageSessionDuration ?? 0;
      acc.position += row.position ?? 0;
      return acc;
    },
    {
      impressions: 0,
      clicks: 0,
      ctr: 0,
      conversions: 0,
      costCents: 0,
      conversionValue: 0,
      averageCpc: 0,
      sessions: 0,
      users: 0,
      engagedSessions: 0,
      averageSessionDuration: 0,
      position: 0,
    },
  );
}

function buildDatasetSummary(rows: MetricRow[], startDate: string, endDate: string) {
  const totals = buildTotals(rows);
  return {
    dateRange: dateRangeLabel(startDate, endDate),
    totals,
    rows,
  };
}

async function fetchGa4Range(tenantId: string, propertyId: string, startDate: string, endDate: string) {
  const analyticsData = await getAnalyticsDataClient(tenantId);
  const response = await analyticsData.properties.runReport({
    property: propertyId,
    requestBody: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "engagedSessions" },
        { name: "averageSessionDuration" },
        { name: "conversions" },
      ],
    },
  });

  const rows = Array.isArray(response.data.rows)
    ? response.data.rows.map((row) => {
        const values = row.metricValues ?? [];
        return {
          date: row.dimensionValues?.[0]?.value ?? "",
          sessions: parseNumber(values[0]?.value),
          users: parseNumber(values[1]?.value),
          engagedSessions: parseNumber(values[2]?.value),
          averageSessionDuration: parseNumber(values[3]?.value),
          conversions: parseNumber(values[4]?.value),
          impressions: 0,
          clicks: 0,
          ctr: 0,
          costCents: 0,
          conversionValue: 0,
          averageCpc: 0,
          position: 0,
        };
      })
    : [];

  return buildDatasetSummary(rows, startDate, endDate);
}

async function fetchSearchConsoleRange(tenantId: string, siteUrl: string, startDate: string, endDate: string) {
  const searchConsole = await getSearchConsoleClient(tenantId);
  const response = await searchConsole.searchanalytics.query(
    {
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ["date"],
        rowLimit: 10000,
      },
    } as unknown as Record<string, unknown>,
  );

  const rows = Array.isArray(response.data.rows)
    ? response.data.rows.map((row) => ({
        date: row.keys?.[0] ?? "",
        clicks: parseNumber(row.clicks),
        impressions: parseNumber(row.impressions),
        ctr: parseNumber(row.ctr),
        position: parseNumber(row.position),
        conversions: 0,
        costCents: 0,
        conversionValue: 0,
        averageCpc: 0,
        sessions: 0,
        users: 0,
        engagedSessions: 0,
        averageSessionDuration: 0,
      }))
    : [];

  return buildDatasetSummary(rows, startDate, endDate);
}

async function fetchGoogleAdsRange(tenantId: string, customerId: string, startDate: string, endDate: string) {
  const body = await queryGoogleAds(
    tenantId,
    customerId,
    `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversion_value, metrics.average_cpc, metrics.ctr FROM customer WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' ORDER BY segments.date`,
  );

  const rows = Array.isArray(body.results)
    ? body.results.map((result) => {
        const segments = result.segments as Record<string, unknown> | undefined;
        const metrics = result.metrics as Record<string, unknown> | undefined;
        const costMicros = parseNumber(metrics?.cost_micros);
        const averageCpc = parseNumber(metrics?.average_cpc);

        return {
          date: typeof segments?.date === "string" ? segments.date : "",
          impressions: parseNumber(metrics?.impressions),
          clicks: parseNumber(metrics?.clicks),
          ctr: parseNumber(metrics?.ctr),
          conversions: parseNumber(metrics?.conversions),
          costCents: Math.round(costMicros / 10000),
          conversionValue: parseNumber(metrics?.conversion_value),
          averageCpc: averageCpc / 1000000,
          position: 0,
          sessions: 0,
          users: 0,
          engagedSessions: 0,
          averageSessionDuration: 0,
        };
      })
    : [];

  return buildDatasetSummary(rows, startDate, endDate);
}

function changeRatio(current: number, previous: number) {
  if (previous === 0) {
    return current === 0 ? 0 : 1;
  }
  return (current - previous) / Math.abs(previous);
}

function roundTwo(value: number) {
  return Math.round(value * 100) / 100;
}

function detectAnomalies(
  ga4Summary: DatasetSummary | null,
  searchConsoleSummary: DatasetSummary | null,
  googleAdsSummary: DatasetSummary | null,
) {
  const anomalies: Anomaly[] = [];

  if (ga4Summary) {
    const currentSessions = ga4Summary.totals.sessions;
    const firstRow = ga4Summary.rows[0];
    const previousSessions = firstRow ? firstRow.sessions : 0;
    if (currentSessions > 0 && previousSessions > 0 && changeRatio(currentSessions, previousSessions) <= -0.2) {
      anomalies.push({
        title: "GA4 sessions dropped significantly",
        description: "Traffic through GA4 is down more than 20% compared to an earlier baseline week.",
        severity: "high",
        category: "ga4",
        evidence: { currentSessions, previousSessions },
      });
    }

    if (ga4Summary.totals.conversions < 3 && ga4Summary.totals.sessions >= 50) {
      anomalies.push({
        title: "GA4 conversion volume is low",
        description: "The site is receiving sessions but generating very few conversions, which may indicate tracking or landing-page issues.",
        severity: "medium",
        category: "ga4",
        evidence: { conversions: ga4Summary.totals.conversions, sessions: ga4Summary.totals.sessions },
      });
    }
  }

  if (searchConsoleSummary) {
    const clicks = searchConsoleSummary.totals.clicks;
    const impressions = searchConsoleSummary.totals.impressions;
    if (impressions > 0 && clicks / impressions < 0.02) {
      anomalies.push({
        title: "Search Console click-through rate is low",
        description: "Organic search impressions are not translating into clicks, which may indicate poor SERP snippet relevance or ranking for non-clickable positions.",
        severity: "medium",
        category: "search_console",
        evidence: { clicks, impressions, ctr: roundTwo((clicks / impressions) * 100) },
      });
    }
  }

  if (googleAdsSummary) {
    const currentCost = googleAdsSummary.totals.costCents;
    const totalConversions = googleAdsSummary.totals.conversions;
    if (totalConversions > 0 && currentCost / totalConversions > 15000) {
      anomalies.push({
        title: "Google Ads cost per conversion is high",
        description: "Ads are spending a lot per conversion, which may reduce campaign profitability for a chauffeur service.",
        severity: "high",
        category: "google_ads",
        evidence: { costCents: currentCost, conversions: totalConversions },
      });
    }
  }

  if (ga4Summary && googleAdsSummary) {
    const ga4Conversions = ga4Summary.totals.conversions;
    const adsConversions = googleAdsSummary.totals.conversions;
    if (ga4Conversions > 0 && adsConversions === 0) {
      anomalies.push({
        title: "No conversions recorded in Google Ads",
        description: "Paid campaigns are generating sessions, but no conversions were reported in Google Ads, which may indicate a tracking mismatch.",
        severity: "high",
        category: "cross_channel",
        evidence: { ga4Conversions, adsConversions },
      });
    }
  }

  return anomalies;
}

function generateRecommendations(
  ga4Summary: DatasetSummary | null,
  searchConsoleSummary: DatasetSummary | null,
  googleAdsSummary: DatasetSummary | null,
) {
  const recommendations: Recommendation[] = [];

  if (ga4Summary) {
    recommendations.push({
      title: "Validate GA4 conversion tracking",
      action: "Check that key booking actions are firing in GA4, including lead submission and request quote events.",
      rationale: "Accurate GA4 conversions are required for reliable performance analysis and Google Ads optimization.",
      category: "ga4",
    });
  }

  if (searchConsoleSummary) {
    recommendations.push({
      title: "Review Search Console performance trends",
      action: "Inspect top queries and landing pages for traffic drops or ranking slips over the past week.",
      rationale: "Organic search performance is a leading signal for demand and can highlight SEO or indexing issues.",
      category: "search_console",
    });
  }

  if (googleAdsSummary) {
    recommendations.push({
      title: "Audit Google Ads campaign efficiency",
      action: "Check conversions and cost per conversion, then pause or reallocate spend away from underperforming campaigns.",
      rationale: "Keeping ad spend focused on profitable leads preserves margins for a chauffeur business.",
      category: "google_ads",
    });
  }

  if (ga4Summary && googleAdsSummary) {
    recommendations.push({
      title: "Match paid conversion tracking across GA4 and Ads",
      action: "Compare conversion counts in GA4 and Google Ads, and investigate any discrepancies in tag firing or goal setup.",
      rationale: "Tracking mismatches can make campaign optimization decisions unreliable.",
      category: "cross_channel",
    });
  }

  return recommendations;
}

export async function analyzeWeeklyMarketingPerformance(
  tenantId: string,
  ga4PropertyId: string,
  searchConsoleSite: string,
  googleAdsCustomerId: string,
): Promise<MarketingAnalysisResult> {
  if (!ga4PropertyId || !searchConsoleSite || !googleAdsCustomerId) {
    throw new Error("GA4 property, Search Console site, and Google Ads customer ID are required.");
  }

  const now = new Date();
  const endDate = now.toISOString().slice(0, 10);
  const currentStartDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [ga4Current, searchConsoleCurrent, googleAdsCurrent] = await Promise.all([
    fetchGa4Range(tenantId, ga4PropertyId, currentStartDate, endDate),
    fetchSearchConsoleRange(tenantId, searchConsoleSite, currentStartDate, endDate),
    fetchGoogleAdsRange(tenantId, googleAdsCustomerId, currentStartDate, endDate),
  ]);

  const ga4 = ga4Current;
  const searchConsole = searchConsoleCurrent;
  const googleAds = googleAdsCurrent;

  const anomalies = detectAnomalies(ga4, searchConsole, googleAds);
  const recommendations = generateRecommendations(ga4, searchConsole, googleAds);

  return {
    ga4,
    searchConsole,
    googleAds,
    anomalies,
    recommendations,
    generatedAt: new Date().toISOString(),
  };
}
