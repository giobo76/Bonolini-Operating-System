import { TRPCError } from "@trpc/server";
import { createServerCaller } from "@bos/core";
import { PermissionDenied } from "../permission-denied";

function formatDate(value: Date | string) {
  return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export default async function MarketingReportsPage() {
  const caller = await createServerCaller();

  let reports;
  try {
    reports = await caller.marketing.listReports();
  } catch (error) {
    if (error instanceof TRPCError && error.code === "FORBIDDEN") {
      return <PermissionDenied />;
    }
    throw error;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <div>
        <a href="/marketing" className="text-sm text-neutral-500 underline dark:text-neutral-400">
          ← Marketing Intelligence
        </a>
        <h1 className="text-2xl font-semibold">Weekly Reports</h1>
      </div>

      {reports.length === 0 ? (
        <p className="text-sm text-neutral-400">
          No reports yet — the weekly report job hasn&apos;t run. It&apos;s scheduled for
          Monday mornings once the Inngest jobs are running (see the marketing
          README for local/production setup).
        </p>
      ) : (
        <ul className="space-y-2">
          {reports.map((report) => (
            <li key={report.id} className="rounded border p-3 text-sm">
              <a href={`/marketing/reports/${report.id}`} className="underline">
                {formatDate(report.periodStart)} – {formatDate(report.periodEnd)}
              </a>
              <div className="text-xs text-neutral-500 dark:text-neutral-400">
                Generated {formatDate(report.generatedAt)}
                {report.emailedAt ? ` · Emailed ${formatDate(report.emailedAt)}` : " · Not emailed"}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
