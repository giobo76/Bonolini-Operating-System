import Link from "next/link";
import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";
import { createServerCaller } from "@bos/core";
import { PermissionDenied } from "../../permission-denied";

function formatDate(value: Date | string) {
  return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export default async function MarketingReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const caller = await createServerCaller();

  let report;
  try {
    report = await caller.marketing.getReport({ id });
  } catch (error) {
    if (error instanceof TRPCError) {
      if (error.code === "FORBIDDEN") return <PermissionDenied />;
      if (error.code === "NOT_FOUND") notFound();
    }
    throw error;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <div>
        <Link href="/marketing/reports" className="text-sm text-neutral-500 underline dark:text-neutral-400">
          ← Reports
        </Link>
        <h1 className="text-2xl font-semibold">
          {formatDate(report.periodStart)} – {formatDate(report.periodEnd)}
        </h1>
        <p className="text-xs text-neutral-400">
          Generated {formatDate(report.generatedAt)}
          {report.emailedAt ? ` · Emailed ${formatDate(report.emailedAt)}` : " · Not emailed"}
        </p>
      </div>

      <article className="whitespace-pre-wrap rounded border p-4 text-sm">{report.content}</article>
    </main>
  );
}
