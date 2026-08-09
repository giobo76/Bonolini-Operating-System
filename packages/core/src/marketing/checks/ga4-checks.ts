import { getAnalyticsDataClient } from "../google-clients";
import type { FindingDraft } from "../rule-types";

// Events transfer-web is actually instrumented to send today — see
// apps/transfer-web/app/layout.tsx (GTM snippet) and
// apps/transfer-web/app/request-quote/thank-you/page.tsx (generate_lead
// push). Deliberately NOT checking for a "purchase" event: there's no real
// checkout/payment flow yet (Booking Management/Payments aren't built), so
// asserting one exists would be checking for tracking that was never
// wired up. Extend this list as transfer-web gains more instrumented events.
const EXPECTED_EVENTS = ["page_view", "generate_lead"];

const MIN_BASELINE_SESSIONS = 20;
const TRAFFIC_DROP_THRESHOLD = -0.5;

function normalizeProperty(propertyId: string): string {
  return propertyId.startsWith("properties/") ? propertyId : `properties/${propertyId}`;
}

export async function runChecks(tenantId: string, propertyId: string): Promise<FindingDraft[]> {
  const analyticsData = await getAnalyticsDataClient(tenantId);
  const property = normalizeProperty(propertyId);
  const drafts: FindingDraft[] = [];

  const [recentEvents, previousEvents] = await Promise.all([
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [{ startDate: "3daysAgo", endDate: "today" }],
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "eventCount" }],
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [{ startDate: "10daysAgo", endDate: "4daysAgo" }],
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "eventCount" }],
      },
    }),
  ]);

  const recentCounts = new Map(
    (recentEvents.data.rows ?? []).map((row) => [
      row.dimensionValues?.[0]?.value ?? "",
      Number(row.metricValues?.[0]?.value ?? 0),
    ]),
  );
  const previousCounts = new Map(
    (previousEvents.data.rows ?? []).map((row) => [
      row.dimensionValues?.[0]?.value ?? "",
      Number(row.metricValues?.[0]?.value ?? 0),
    ]),
  );

  for (const eventName of EXPECTED_EVENTS) {
    const recentCount = recentCounts.get(eventName) ?? 0;
    const previousCount = previousCounts.get(eventName) ?? 0;

    if (recentCount === 0 && previousCount > 0) {
      const isConversionEvent = eventName === "generate_lead";
      drafts.push({
        dedupeKey: `ga4_event_stopped:${propertyId}:${eventName}`,
        category: "conversion_tracking",
        nature: "technical_issue",
        severity: "critical",
        confidenceScore: 85,
        title: `GA4 event "${eventName}" stopped firing`,
        observation: `"${eventName}" fired ${previousCount} times in the prior comparable period but 0 times in the last 3 days.`,
        rootCause:
          "Likely a GTM tag/trigger change, a site code change that removed the tracking call, or a GA4 configuration change.",
        businessImpact: isConversionEvent
          ? "Conversion tracking is broken — Google Ads can't optimize toward this goal, and reported performance will look artificially worse than it is."
          : "This event's data is no longer being collected.",
        financialImpact: isConversionEvent
          ? {
              amount: null,
              currency: "EUR",
              period: "daily",
              direction: "cost",
              note: "Automated bidding strategies may under-serve or pause campaigns that appear to have zero conversions.",
            }
          : null,
        recommendedActions: [
          "Check GTM for recent changes to this event's tag/trigger",
          "Verify the event still fires using GA4 DebugView or GTM Preview mode",
          "Check for recent transfer-web code changes",
        ],
        requiresApproval: false,
        expectedBenefit: "Restores accurate conversion data for bidding and reporting.",
        evidence: { propertyId, eventName, recentCount, previousCount },
      });
    }
  }

  const [recentSessions, previousSessions] = await Promise.all([
    analyticsData.properties.runReport({
      property,
      requestBody: { dateRanges: [{ startDate: "3daysAgo", endDate: "today" }], metrics: [{ name: "sessions" }] },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [{ startDate: "10daysAgo", endDate: "4daysAgo" }],
        metrics: [{ name: "sessions" }],
      },
    }),
  ]);

  const recentSessionCount = Number(recentSessions.data.rows?.[0]?.metricValues?.[0]?.value ?? 0);
  const previousSessionCount = Number(previousSessions.data.rows?.[0]?.metricValues?.[0]?.value ?? 0);

  if (previousSessionCount >= MIN_BASELINE_SESSIONS) {
    const change = (recentSessionCount - previousSessionCount) / previousSessionCount;
    if (change <= TRAFFIC_DROP_THRESHOLD) {
      drafts.push({
        dedupeKey: `ga4_traffic_drop:${propertyId}`,
        category: "organic_traffic",
        nature: "technical_issue",
        severity: "high",
        confidenceScore: 70,
        title: "Significant traffic drop",
        observation: `Sessions dropped ${Math.round(Math.abs(change) * 100)}% (${previousSessionCount} → ${recentSessionCount}) vs. the prior comparable period.`,
        rootCause:
          "Could be a tracking issue (GA4/GTM broken), a paused/limited campaign, a site outage, or a genuine demand drop — check the other findings from this run first.",
        businessImpact: "Fewer visitors means fewer leads and bookings, regardless of cause.",
        financialImpact: null,
        recommendedActions: [
          "Rule out a tracking issue first (check conversion_tracking and gtm_configuration findings)",
          "Check Google Ads campaign status",
          "Check Search Console for indexing/crawl issues",
        ],
        requiresApproval: false,
        expectedBenefit: "Identifying the cause allows restoring traffic to normal levels.",
        evidence: { propertyId, recentSessionCount, previousSessionCount, changePct: change },
      });
    }
  }

  return drafts;
}
