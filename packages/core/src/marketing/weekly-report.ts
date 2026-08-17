import { and, eq, gte, or } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { getDb, findings as findingsTable, marketingHealthScores, reports, assertOne, type Finding } from "@bos/db";
import { sendWeeklyDigestEmail } from "./alerts";

export interface WeeklyReportFindingSummary {
  category: string;
  severity: string;
  title: string;
  businessImpact: string;
}

export interface WeeklyReportBuckets {
  activeIssues: WeeklyReportFindingSummary[];
  resolvedThisWeek: WeeklyReportFindingSummary[];
  dismissedThisWeek: WeeklyReportFindingSummary[];
  newThisWeek: WeeklyReportFindingSummary[];
}

type BucketableFinding = Pick<
  Finding,
  "status" | "category" | "severity" | "title" | "businessImpact" | "firstDetectedAt" | "resolvedAt" | "updatedAt"
>;

function toSummary(f: BucketableFinding): WeeklyReportFindingSummary {
  return { category: f.category, severity: f.severity, title: f.title, businessImpact: f.businessImpact };
}

// Splits the findings relevant to this report into four buckets, so a
// finding that stopped being a problem days ago is never presented as
// current risk just because it happens to fall inside the 7-day window.
// ACTIVE ISSUES is keyed purely on current status — independent of when the
// finding was first detected — which is what makes a finding resolved
// before periodStart correctly disappear from "current risk" even though
// the old single query (gte(firstDetectedAt, periodStart), no status
// filter) kept surfacing it for as long as it stayed inside the window.
//
// dismissedThisWeek uses `updatedAt` as a proxy for "dismissed this week":
// findings has no `dismissedAt` column (only `resolvedAt`, which
// updateFindingStatus only ever sets for status "resolved" — see
// service.ts). This is an approximation, not an exact signal — a dismissed
// finding touched again for an unrelated reason would also show up here.
export function bucketFindingsForWeeklyReport(
  relevantFindings: BucketableFinding[],
  periodStart: Date,
): WeeklyReportBuckets {
  return {
    activeIssues: relevantFindings.filter((f) => f.status === "open").map(toSummary),
    resolvedThisWeek: relevantFindings
      .filter((f) => f.status === "resolved" && f.resolvedAt !== null && f.resolvedAt >= periodStart)
      .map(toSummary),
    dismissedThisWeek: relevantFindings
      .filter((f) => f.status === "dismissed" && f.updatedAt >= periodStart)
      .map(toSummary),
    newThisWeek: relevantFindings.filter((f) => f.firstDetectedAt >= periodStart).map(toSummary),
  };
}

const WEEKLY_REPORT_RULE = `Only ACTIVE ISSUES represent current business risk.

Never describe a RESOLVED or DISMISSED finding as an ongoing problem.

RESOLVED THIS WEEK and DISMISSED THIS WEEK may only be referenced as historical context or completed actions.

NEW THIS WEEK describes findings first detected during the reporting period and may overlap with ACTIVE ISSUES. Do not infer that a NEW finding is still active unless it is also present in ACTIVE ISSUES.`;

function formatFindingLine(f: WeeklyReportFindingSummary): string {
  return `- [${f.severity}] ${f.title} (${f.category}): ${f.businessImpact}`;
}

// Exported for direct testing (Anthropic mocked at the module boundary),
// same rationale as the other pure/near-pure decision functions in this
// package (e.g. ga4-checks.ts's severityForBaseline).
export async function synthesizeWeeklyNarrative(buckets: WeeklyReportBuckets, scores: number[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Same active/historical/context semantics as the Claude-backed path
    // below, just rendered as plain text instead of synthesized — a
    // resolved/dismissed finding must never appear under the active-issues
    // heading here either.
    return [
      "Weekly Marketing Intelligence report",
      "",
      "(Narrative synthesis unavailable — ANTHROPIC_API_KEY is not set on the server. Raw data below.)",
      "",
      scores.length ? `Health Score readings: ${scores.join(", ")}` : "No Health Score readings this week.",
      "",
      `ACTIVE ISSUES (current risk) — ${buckets.activeIssues.length}`,
      ...buckets.activeIssues.map(formatFindingLine),
      "",
      `RESOLVED THIS WEEK (historical — already fixed, not current risk) — ${buckets.resolvedThisWeek.length}`,
      ...buckets.resolvedThisWeek.map(formatFindingLine),
      "",
      `DISMISSED THIS WEEK (historical — reviewed and dismissed, not current risk) — ${buckets.dismissedThisWeek.length}`,
      ...buckets.dismissedThisWeek.map(formatFindingLine),
      "",
      `NEW THIS WEEK (context only — may overlap with ACTIVE ISSUES above) — ${buckets.newThisWeek.length}`,
      ...buckets.newThisWeek.map(formatFindingLine),
    ].join("\n");
  }

  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2048,
    system:
      "You are a senior Google Ads strategist, CRO specialist, GA4 analyst, and technical SEO consultant writing a weekly executive report for the owner of Bonolini Transfer, a small chauffeur business. Be concise and concrete, and prioritize by business impact. Never recommend automatic execution of budget/campaign/bid/keyword changes — every recommendation is for the owner to review and execute manually.",
    messages: [
      {
        role: "user",
        content: `${WEEKLY_REPORT_RULE}

ACTIVE ISSUES:
${JSON.stringify(buckets.activeIssues, null, 2)}

RESOLVED THIS WEEK:
${JSON.stringify(buckets.resolvedThisWeek, null, 2)}

DISMISSED THIS WEEK:
${JSON.stringify(buckets.dismissedThisWeek, null, 2)}

NEW THIS WEEK:
${JSON.stringify(buckets.newThisWeek, null, 2)}

Health Score readings this week: ${scores.join(", ") || "none recorded"}

Write a weekly executive report covering: performance summary, conversion funnel health, technical issues, SEO/organic traffic summary, strategic recommendations for next week, and a bottom line. Ground "current risk" and "technical issues" only in ACTIVE ISSUES — use RESOLVED THIS WEEK and DISMISSED THIS WEEK only as brief historical context (e.g. "3 issues were resolved this week"), never as pending problems. Only cover topics the data actually supports — if there's no Google Ads data available yet (spend, CPC, campaigns), say so plainly rather than inventing it. Plain text or simple markdown, not JSON.`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock && textBlock.type === "text" ? textBlock.text : "Report generation failed — no text returned.";
}

export async function runWeeklyReport(tenantId: string) {
  const db = getDb();
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [relevantFindings, weekScores] = await Promise.all([
    // One query covering the superset any of the four buckets could need —
    // open (regardless of age), resolved/dismissed within the window, or
    // first detected within the window — bucketed in JS by
    // bucketFindingsForWeeklyReport so the split logic is a plain, directly
    // testable function rather than four separate round-trips.
    db
      .select()
      .from(findingsTable)
      .where(
        and(
          eq(findingsTable.tenantId, tenantId),
          or(
            eq(findingsTable.status, "open"),
            and(eq(findingsTable.status, "resolved"), gte(findingsTable.resolvedAt, periodStart)),
            and(eq(findingsTable.status, "dismissed"), gte(findingsTable.updatedAt, periodStart)),
            gte(findingsTable.firstDetectedAt, periodStart),
          ),
        ),
      ),
    db
      .select()
      .from(marketingHealthScores)
      .where(
        and(eq(marketingHealthScores.tenantId, tenantId), gte(marketingHealthScores.computedAt, periodStart)),
      ),
  ]);

  const buckets = bucketFindingsForWeeklyReport(relevantFindings, periodStart);

  const content = await synthesizeWeeklyNarrative(buckets, weekScores.map((s) => s.overallScore));

  const reportRows = await db
    .insert(reports)
    .values({ tenantId, periodStart, periodEnd, content })
    .returning();
  const report = assertOne(reportRows, "runWeeklyReport: create reports row");

  const emailed = await sendWeeklyDigestEmail(content);
  if (emailed) {
    await db.update(reports).set({ emailedAt: new Date() }).where(eq(reports.id, report.id));
  }

  return report;
}
