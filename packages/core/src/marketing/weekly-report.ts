import { and, eq, gte } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { getDb, findings as findingsTable, marketingHealthScores, reports, assertOne } from "@bos/db";
import { sendWeeklyDigestEmail } from "./alerts";

async function synthesizeWeeklyNarrative(
  weekFindings: Array<{ category: string; severity: string; title: string; businessImpact: string }>,
  scores: number[],
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return [
      "Weekly Marketing Intelligence report",
      "",
      "(Narrative synthesis unavailable — ANTHROPIC_API_KEY is not set on the server. Raw data below.)",
      "",
      `${weekFindings.length} findings this week.`,
      scores.length ? `Health Score readings: ${scores.join(", ")}` : "No Health Score readings this week.",
      "",
      ...weekFindings.map((f) => `- [${f.severity}] ${f.title} (${f.category}): ${f.businessImpact}`),
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
        content: `This week's findings:\n${JSON.stringify(weekFindings, null, 2)}\n\nHealth Score readings this week: ${scores.join(", ") || "none recorded"}\n\nWrite a weekly executive report covering: performance summary, conversion funnel health, technical issues, SEO summary, and strategic recommendations for next week. Only cover topics the data actually supports — if there's no Google Ads data available yet (spend, CPC, campaigns), say so plainly rather than inventing it. Plain text or simple markdown, not JSON.`,
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

  const [weekFindings, weekScores] = await Promise.all([
    db
      .select()
      .from(findingsTable)
      .where(and(eq(findingsTable.tenantId, tenantId), gte(findingsTable.firstDetectedAt, periodStart))),
    db
      .select()
      .from(marketingHealthScores)
      .where(
        and(eq(marketingHealthScores.tenantId, tenantId), gte(marketingHealthScores.computedAt, periodStart)),
      ),
  ]);

  const content = await synthesizeWeeklyNarrative(
    weekFindings.map((f) => ({
      category: f.category,
      severity: f.severity,
      title: f.title,
      businessImpact: f.businessImpact,
    })),
    weekScores.map((s) => s.overallScore),
  );

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
