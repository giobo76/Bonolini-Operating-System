import Link from "next/link";
import { TRPCError } from "@trpc/server";
import { createServerCaller, type FinancialImpact } from "@bos/core";
import { PermissionDenied } from "./permission-denied";
import { runCheckNowAction, updateFindingStatusAction } from "./actions";

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
  medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
  low: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

const COMPONENT_LABELS: Record<string, string> = {
  trackingIntegrity: "Tracking Integrity",
  accountHealth: "Account Health",
  efficiency: "Efficiency",
  technicalSiteHealth: "Technical / Site Health",
};

function formatMoney(impact: FinancialImpact) {
  if (impact.amount == null) return null;
  const formatted = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: impact.currency,
  }).format(impact.amount);
  const period = impact.period === "one_time" ? "one-time" : `/${impact.period.replace("ly", "")}`;
  return `${impact.direction === "cost" ? "−" : "+"}${formatted}${impact.period === "one_time" ? " (one-time)" : period}`;
}

function formatDate(value: Date | string) {
  return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function formatCents(cents: number, currency = "EUR") {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(cents / 100);
}

function formatRate(rate: number | null) {
  return rate == null ? "Not enough data yet" : `${(rate * 100).toFixed(0)}%`;
}

export default async function MarketingOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const analyzed = sp.analyzed === "1";
  const errorParam = Array.isArray(sp.error) ? sp.error[0] : sp.error;

  const caller = await createServerCaller();

  let healthScore, history, openFindings, funnel, conversionRates, revenueBySource, ltvBySource;
  try {
    [
      healthScore,
      history,
      openFindings,
      funnel,
      conversionRates,
      revenueBySource,
      ltvBySource,
    ] = await Promise.all([
      caller.marketing.getHealthScore(),
      caller.marketing.listHealthScoreHistory(),
      caller.marketing.listFindings({ status: "open", pageSize: 100 }),
      caller.marketing.getFunnelSummary(),
      caller.marketing.getConversionRates(),
      caller.marketing.getRevenueBySource(),
      caller.marketing.getLtvBySource(),
    ]);
  } catch (error) {
    if (error instanceof TRPCError && error.code === "FORBIDDEN") {
      return <PermissionDenied />;
    }
    throw error;
  }

  const technicalIssues = openFindings
    .filter((f) => f.nature === "technical_issue")
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const strategicOpportunities = openFindings
    .filter((f) => f.nature === "strategic_opportunity")
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-start justify-between">
        <div>
          <Link href="/" className="text-sm text-neutral-500 underline dark:text-neutral-400">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-semibold">Marketing Intelligence</h1>
        </div>
        <div className="flex gap-2">
          <Link href="/marketing/reports" className="rounded border px-3 py-1.5 text-sm">
            Reports
          </Link>
          <Link href="/marketing/connections" className="rounded border px-3 py-1.5 text-sm">
            Connections
          </Link>
          <form action={runCheckNowAction}>
            <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
              Analyze Now
            </button>
          </form>
        </div>
      </header>

      {analyzed ? (
        <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400">
          Analysis complete.
        </p>
      ) : null}
      {errorParam ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          Analysis failed: {errorParam}
        </p>
      ) : null}

      <section className="rounded border p-4">
        <h2 className="mb-1 text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Business Performance
        </h2>
        <p className="mb-3 text-xs text-neutral-400">
          Real outcomes, not just ad metrics — Click → Lead → Quote → Confirmed → Completed.
          Cost-per-stage isn&apos;t shown yet: it needs real Google Ads spend data, not yet
          integrated (see packages/core/src/marketing/README.md).
        </p>

        {funnel.overall.leads === 0 ? (
          <p className="text-sm text-neutral-400">
            No leads yet — once someone submits &quot;Request a Quote&quot; on transfer-web,
            the funnel starts populating here.
          </p>
        ) : (
          <>
            <table className="mb-4 w-full text-left text-sm">
              <thead>
                <tr className="border-b text-neutral-500 dark:text-neutral-400">
                  <th className="py-1 pr-3">Source</th>
                  <th className="py-1 pr-3">Leads</th>
                  <th className="py-1 pr-3">Quotes</th>
                  <th className="py-1 pr-3">Accepted</th>
                  <th className="py-1 pr-3">Confirmed</th>
                  <th className="py-1 pr-3">Completed</th>
                  <th className="py-1 pr-3">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {funnel.bySource.map((row) => {
                  const revenue = revenueBySource.find((r) => r.source === row.source);
                  return (
                    <tr key={row.source} className="border-b last:border-0">
                      <td className="py-1 pr-3">{row.source}</td>
                      <td className="py-1 pr-3">{row.leads}</td>
                      <td className="py-1 pr-3">{row.quotes}</td>
                      <td className="py-1 pr-3">{row.quotesAccepted}</td>
                      <td className="py-1 pr-3">{row.bookingsConfirmed}</td>
                      <td className="py-1 pr-3">{row.bookingsCompleted}</td>
                      <td className="py-1 pr-3">
                        {revenue ? formatCents(revenue.revenueCents) : "€0.00"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  Quote acceptance rate
                </div>
                <div className="font-medium">{formatRate(conversionRates.quoteAcceptanceRate)}</div>
              </div>
              <div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  Deposit conversion rate
                </div>
                <div className="font-medium">
                  {formatRate(conversionRates.depositConversionRate)}
                </div>
              </div>
              <div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  Booking completion rate
                </div>
                <div className="font-medium">
                  {formatRate(conversionRates.bookingCompletionRate)}
                </div>
              </div>
              <div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  Return customer rate
                </div>
                <div className="font-medium">{formatRate(conversionRates.returnCustomerRate)}</div>
              </div>
            </div>

            {ltvBySource.length > 0 ? (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-neutral-500 dark:text-neutral-400">
                    <th className="py-1 pr-3">Source</th>
                    <th className="py-1 pr-3">Clients</th>
                    <th className="py-1 pr-3">Avg. LTV</th>
                  </tr>
                </thead>
                <tbody>
                  {ltvBySource.map((row) => (
                    <tr key={row.source} className="border-b last:border-0">
                      <td className="py-1 pr-3">{row.source}</td>
                      <td className="py-1 pr-3">{row.clientCount}</td>
                      <td className="py-1 pr-3">{formatCents(row.averageRevenueCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        )}
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-2 text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Marketing Health Score
        </h2>
        {healthScore ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-semibold">{healthScore.overallScore}</span>
              <span className="text-neutral-500 dark:text-neutral-400">/ 100</span>
            </div>
            {healthScore.summary ? <p className="mt-1 text-sm">{healthScore.summary}</p> : null}
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {Object.entries(healthScore.breakdown as Record<string, number>).map(
                ([component, score]) => (
                  <div key={component}>
                    <div className="text-neutral-500 dark:text-neutral-400">
                      {COMPONENT_LABELS[component] ?? component}
                    </div>
                    <div className="text-lg font-medium">{score}</div>
                  </div>
                ),
              )}
            </div>
            <p className="mt-2 text-xs text-neutral-400">
              As of {formatDate(healthScore.computedAt)}
            </p>
          </>
        ) : (
          <p className="text-sm text-neutral-400">
            Not yet available — no health checks have run. This starts populating
            once MIE-2&apos;s monitoring jobs ship.
          </p>
        )}
      </section>

      {history.length > 1 ? (
        <section className="rounded border p-4">
          <h2 className="mb-2 text-sm font-medium text-neutral-500 dark:text-neutral-400">
            Score history
          </h2>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-neutral-500 dark:text-neutral-400">
                <th className="py-1 pr-4">Date</th>
                <th className="py-1 pr-4">Score</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id} className="border-b last:border-0">
                  <td className="py-1 pr-4">{formatDate(entry.computedAt)}</td>
                  <td className="py-1 pr-4">{entry.overallScore}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Technical Issues{" "}
          <span className="font-normal">— active harm, drags the Health Score down</span>
        </h2>
        {technicalIssues.length === 0 ? (
          <p className="text-sm text-neutral-400">
            No open technical issues{openFindings.length === 0 ? " — no monitoring data yet." : "."}
          </p>
        ) : (
          <ul className="space-y-3">
            {technicalIssues.map((finding) => (
              <FindingCard key={finding.id} finding={finding} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Strategic Opportunities{" "}
          <span className="font-normal">— unrealized upside, not active harm</span>
        </h2>
        {strategicOpportunities.length === 0 ? (
          <p className="text-sm text-neutral-400">
            No open opportunities identified
            {openFindings.length === 0 ? " — no monitoring data yet." : "."}
          </p>
        ) : (
          <ul className="space-y-3">
            {strategicOpportunities.map((finding) => (
              <FindingCard key={finding.id} finding={finding} />
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-neutral-400">
        MIE-2 (the actual quick-check/daily-audit jobs that produce findings) hasn&apos;t
        shipped yet — this page reflects real data once it does.
      </p>
    </main>
  );
}

function FindingCard({
  finding,
}: {
  finding: {
    id: string;
    title: string;
    severity: string;
    confidenceScore: number;
    observation: string;
    rootCause: string | null;
    businessImpact: string;
    financialImpact: unknown;
    recommendedActions: unknown;
    requiresApproval: boolean;
    expectedBenefit: string | null;
  };
}) {
  const impact = finding.financialImpact as FinancialImpact | null;
  const actions = (finding.recommendedActions as string[] | null) ?? [];

  return (
    <li className="rounded border p-3 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <span
          className={`rounded px-2 py-0.5 text-xs capitalize ${SEVERITY_STYLES[finding.severity]}`}
        >
          {finding.severity}
        </span>
        <span className="text-xs text-neutral-400">{finding.confidenceScore}% confidence</span>
        {finding.requiresApproval ? (
          <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-900 dark:text-blue-300">
            Requires approval
          </span>
        ) : null}
        <span className="font-medium">{finding.title}</span>
      </div>
      <dl className="space-y-1">
        <div>
          <dt className="inline text-neutral-500 dark:text-neutral-400">Observation: </dt>
          <dd className="inline">{finding.observation}</dd>
        </div>
        {finding.rootCause ? (
          <div>
            <dt className="inline text-neutral-500 dark:text-neutral-400">Root cause: </dt>
            <dd className="inline">{finding.rootCause}</dd>
          </div>
        ) : null}
        <div>
          <dt className="inline text-neutral-500 dark:text-neutral-400">Business impact: </dt>
          <dd className="inline">{finding.businessImpact}</dd>
        </div>
        {impact ? (
          <div>
            <dt className="inline text-neutral-500 dark:text-neutral-400">Financial impact: </dt>
            <dd className="inline">{formatMoney(impact)}</dd>
          </div>
        ) : null}
        {actions.length > 0 ? (
          <div>
            <dt className="text-neutral-500 dark:text-neutral-400">Recommended actions:</dt>
            <dd>
              <ul className="list-disc pl-5">
                {actions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        {finding.expectedBenefit ? (
          <div>
            <dt className="inline text-neutral-500 dark:text-neutral-400">Expected benefit: </dt>
            <dd className="inline">{finding.expectedBenefit}</dd>
          </div>
        ) : null}
      </dl>
      <div className="mt-2 flex gap-2">
        <form action={updateFindingStatusAction}>
          <input type="hidden" name="id" value={finding.id} />
          <input type="hidden" name="status" value="resolved" />
          <button type="submit" className="rounded border px-2 py-1 text-xs">
            Mark resolved
          </button>
        </form>
        <form action={updateFindingStatusAction}>
          <input type="hidden" name="id" value={finding.id} />
          <input type="hidden" name="status" value="dismissed" />
          <button type="submit" className="rounded border px-2 py-1 text-xs text-neutral-500 dark:text-neutral-400">
            Dismiss
          </button>
        </form>
      </div>
    </li>
  );
}
