import { and, eq, gte } from "drizzle-orm";
import { getDb, clients } from "@bos/db";
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

// Both the "event stopped firing" and "traffic drop" checks below compare a
// recent period against a prior one. The two periods MUST be the same
// duration and contiguous (no gap, no overlap) — comparing sums across
// windows of different lengths silently inflates whatever percentage change
// gets computed (a 4-day window vs. a 7-day window makes a normal
// week-to-week fluctuation look like a much bigger drop than it is). Deriving
// both ranges from WINDOW_DAYS, instead of hand-writing "3daysAgo"/
// "10daysAgo" literals, keeps them equal by construction if this ever changes.
const WINDOW_DAYS = 7;

function daysAgo(n: number): string {
  return n === 0 ? "today" : `${n}daysAgo`;
}

const RECENT_RANGE = { startDate: daysAgo(WINDOW_DAYS - 1), endDate: daysAgo(0) };
const PREVIOUS_RANGE = { startDate: daysAgo(WINDOW_DAYS * 2 - 1), endDate: daysAgo(WINDOW_DAYS) };

const MIN_BASELINE_SESSIONS = 20;
const TRAFFIC_DROP_THRESHOLD = -0.5;

// Reuses the exact same volume-gate value as attribution-checks.ts's
// MIN_LEADS_FOR_CHECK — same "is this even enough leads to trust a
// conclusion" judgment, applied here to a different data source.
const MIN_LEADS_FOR_TRACKING_GAP_CHECK = 10;

// Severity/confidence scale with the size of the baseline sample, not just
// the raw percentage change — a 50%+ drop on a handful of sessions is much
// less reliable a signal than the same percentage on a large sample, and
// treating both as equally "high" overstates the smaller one. See
// docs discussion in the MIE validation session: the -0.5 threshold alone
// previously produced a "high" finding off a 44-session baseline.
const HIGH_SEVERITY_MIN_SESSIONS = 100;

export function severityForBaseline(previousSessionCount: number): "medium" | "high" {
  return previousSessionCount >= HIGH_SEVERITY_MIN_SESSIONS ? "high" : "medium";
}

// Tiered rather than a formula: the three bands are an explicit editorial
// judgment call (see severityForBaseline's comment), not a statistically
// derived function, so a lookup table is more honest than a fitted curve.
export function confidenceForBaseline(previousSessionCount: number): number {
  if (previousSessionCount >= 100) return 80;
  if (previousSessionCount >= 50) return 70;
  return 55; // previousSessionCount is >= MIN_BASELINE_SESSIONS (20) here — see call site
}

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
        dateRanges: [RECENT_RANGE],
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "eventCount" }],
      },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: [PREVIOUS_RANGE],
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
        observation: `"${eventName}" fired ${previousCount} times in the prior comparable ${WINDOW_DAYS}-day period but 0 times in the last ${WINDOW_DAYS} days.`,
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

  // Cross-check against BOS's own first-party lead data (the `clients`
  // table, same source attribution-checks.ts already treats as the most
  // reliable in the catalog — no Google API involved). This catches a
  // conversion event that has NEVER fired at all, which the event-stopped-
  // firing check above structurally cannot see (it only fires when
  // previousCount > 0). Verified real gap, 2026-08-28: 28 real leads in
  // BOS's own DB over the prior 8 days, 0 generate_lead events ever
  // recorded in GA4 over the same period — this is the founder's own FASE 4
  // distinction ("users arrive but no conversion is recorded") with real
  // evidence behind it, not a hypothesis.
  const recentGenerateLeadCount = recentCounts.get("generate_lead") ?? 0;
  if (recentGenerateLeadCount === 0) {
    const db = getDb();
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const recentLeads = await db
      .select()
      .from(clients)
      .where(and(eq(clients.tenantId, tenantId), gte(clients.createdAt, since)));

    if (recentLeads.length >= MIN_LEADS_FOR_TRACKING_GAP_CHECK) {
      drafts.push({
        dedupeKey: `conversion_tracking_gap:${propertyId}:generate_lead`,
        category: "conversion_tracking",
        nature: "technical_issue",
        severity: "critical",
        confidenceScore: 85,
        title: "Real leads are arriving but GA4 shows zero conversion events",
        observation: `${recentLeads.length} real lead(s) were recorded in BOS over the last ${WINDOW_DAYS} days, but GA4's "generate_lead" event fired 0 times in the same period.`,
        rootCause:
          "Users are completing the request-quote flow (proven by BOS's own database), but the GA4 conversion event isn't reaching Google Analytics — likely a GTM tag/trigger issue, a consent/cookie tool blocking the script before it fires, or the thank-you page not being reached in the real flow the way it is in testing.",
        businessImpact:
          "This is a tracking gap, not a demand gap: real leads are arriving, but Google Ads and GA4 both report zero conversions, which can cause Google Ads' automated bidding to under-serve campaigns that are actually working.",
        financialImpact: {
          amount: null,
          currency: "EUR",
          period: "weekly",
          direction: "cost",
          note: "Automated bidding may under-serve campaigns that appear to convert at 0%, even though real leads are arriving.",
        },
        recommendedActions: [
          "Verify the generate_lead dataLayer push actually fires in a real browser session (GTM Preview mode or GA4 DebugView)",
          "Check for a consent/cookie tool blocking the GTM script before the event can fire",
          "Confirm the thank-you page is actually reached after a real form submission in Production, not just in local testing",
        ],
        requiresApproval: false,
        expectedBenefit:
          "Restoring this event lets Google Ads and GA4 see the conversions that are already happening, improving both automated bidding and reporting accuracy.",
        evidence: {
          propertyId,
          tenantId,
          recentLeadsCount: recentLeads.length,
          windowDays: WINDOW_DAYS,
          ga4GenerateLeadCount: recentGenerateLeadCount,
        },
      });
    }
  }

  const [recentSessions, previousSessions] = await Promise.all([
    analyticsData.properties.runReport({
      property,
      requestBody: { dateRanges: [RECENT_RANGE], metrics: [{ name: "sessions" }] },
    }),
    analyticsData.properties.runReport({
      property,
      requestBody: { dateRanges: [PREVIOUS_RANGE], metrics: [{ name: "sessions" }] },
    }),
  ]);

  const recentSessionCount = Number(recentSessions.data.rows?.[0]?.metricValues?.[0]?.value ?? 0);
  const previousSessionCount = Number(previousSessions.data.rows?.[0]?.metricValues?.[0]?.value ?? 0);

  if (previousSessionCount >= MIN_BASELINE_SESSIONS) {
    // Both windows are WINDOW_DAYS long by construction (see RECENT_RANGE/
    // PREVIOUS_RANGE above), so dividing by the same constant would produce
    // the identical ratio as comparing raw sums — the daily-average step is
    // kept explicit anyway so the comparison stays correct even if the two
    // ranges' lengths are ever changed independently in the future.
    const recentDailyAvg = recentSessionCount / WINDOW_DAYS;
    const previousDailyAvg = previousSessionCount / WINDOW_DAYS;
    const change = (recentDailyAvg - previousDailyAvg) / previousDailyAvg;

    if (change <= TRAFFIC_DROP_THRESHOLD) {
      drafts.push({
        dedupeKey: `ga4_traffic_drop:${propertyId}`,
        category: "organic_traffic",
        nature: "technical_issue",
        severity: severityForBaseline(previousSessionCount),
        confidenceScore: confidenceForBaseline(previousSessionCount),
        title: "Significant traffic drop",
        observation: `Sessions dropped ${Math.round(Math.abs(change) * 100)}% (${previousDailyAvg.toFixed(1)}/day → ${recentDailyAvg.toFixed(1)}/day) over two comparable ${WINDOW_DAYS}-day periods (${previousSessionCount} → ${recentSessionCount} total sessions).`,
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
        evidence: {
          propertyId,
          recentSessionCount,
          previousSessionCount,
          recentWindowDays: WINDOW_DAYS,
          previousWindowDays: WINDOW_DAYS,
          recentDailyAvg,
          previousDailyAvg,
          changePct: change,
        },
      });
    }
  }

  return drafts;
}
