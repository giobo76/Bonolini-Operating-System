import Link from "next/link";
import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";
import { createServerCaller } from "@bos/core";
import { PermissionDenied } from "../permission-denied";
import { approveVersionAction, rejectVersionAction } from "../actions";

const STATUS_STYLES: Record<string, string> = {
  effective: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  proposed: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
  approved: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
  superseded: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
};

function formatDate(value: Date | string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

type VersionRow = {
  id: string;
  versionNumber: number;
  status: string;
  content: unknown;
  author: string;
  proposalReasoning: string | null;
  ownerDecision: string | null;
  ownerDecisionReason: string | null;
  decidedAt: Date | string | null;
  effectiveFrom: Date | string | null;
  createdAt: Date | string;
  evidence: Array<{ id: string; source: string; conclusion: string; evidenceType: string; confidence: string }>;
};

function EvidenceList({ evidence }: { evidence: VersionRow["evidence"] }) {
  if (evidence.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-xs text-neutral-500 dark:text-neutral-400">Evidence ({evidence.length}):</div>
      <ul className="mt-1 flex flex-col gap-1">
        {evidence.map((e) => (
          <li key={e.id} className="rounded bg-neutral-50 p-2 text-xs dark:bg-neutral-900">
            <span className="font-medium uppercase">{e.evidenceType}</span>
            {" · "}
            <span className="text-neutral-500 dark:text-neutral-400">confidence: {e.confidence}</span>
            {" · "}
            <span className="text-neutral-400">{e.source}</span>
            <div className="mt-0.5">{e.conclusion}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VersionCard({ ruleId, version, isCurrent }: { ruleId: string; version: VersionRow; isCurrent: boolean }) {
  return (
    <li className="rounded border p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium">
          v{version.versionNumber}
          {isCurrent ? <span className="ml-2 text-xs text-green-600 dark:text-green-400">(current)</span> : null}
        </span>
        <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[version.status] ?? ""}`}>{version.status}</span>
      </div>
      <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        author: {version.author} · proposed {formatDate(version.createdAt)}
      </div>
      <pre className="mt-2 overflow-x-auto rounded bg-neutral-50 p-2 text-xs dark:bg-neutral-900">
        {JSON.stringify(version.content, null, 2)}
      </pre>
      {version.proposalReasoning ? (
        <div className="mt-2 text-xs">
          <span className="text-neutral-500 dark:text-neutral-400">Why this was proposed: </span>
          {version.proposalReasoning}
        </div>
      ) : null}
      <EvidenceList evidence={version.evidence} />
      {version.ownerDecision ? (
        <div className="mt-2 text-xs">
          <span className="text-neutral-500 dark:text-neutral-400">
            Founder {version.ownerDecision} on {formatDate(version.decidedAt)}
            {version.effectiveFrom ? ` · effective from ${formatDate(version.effectiveFrom)}` : ""}:{" "}
          </span>
          {version.ownerDecisionReason ?? <span className="text-neutral-400">(no reason given)</span>}
        </div>
      ) : null}
      {version.status === "proposed" ? (
        <div className="mt-3 flex flex-col gap-2 border-t pt-3">
          <form action={approveVersionAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="versionId" value={version.id} />
            <input type="hidden" name="ruleId" value={ruleId} />
            <input
              type="text"
              name="reasoning"
              placeholder="Reasoning (optional)"
              className="rounded border px-2 py-1 text-xs"
            />
            <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white">
              Approve
            </button>
          </form>
          <form action={rejectVersionAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="versionId" value={version.id} />
            <input type="hidden" name="ruleId" value={ruleId} />
            <input
              type="text"
              name="reasoning"
              required
              placeholder="Reason for rejection (required)"
              className="rounded border px-2 py-1 text-xs"
            />
            <button type="submit" className="rounded border px-3 py-1.5 text-xs">
              Reject
            </button>
          </form>
        </div>
      ) : null}
    </li>
  );
}

export default async function BusinessRuleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const errorParam = Array.isArray(sp.error) ? sp.error[0] : sp.error;

  const caller = await createServerCaller();

  let rule;
  try {
    rule = await caller.businessRules.get({ id });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "FORBIDDEN") {
      return <PermissionDenied />;
    }
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }

  const versions = rule.versions as VersionRow[];
  const proposed = versions.filter((v) => v.status === "proposed");
  const history = versions.filter((v) => v.status !== "proposed");

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header>
        <Link href="/business-rules" className="text-sm text-neutral-500 underline dark:text-neutral-400">
          ← Business Rules
        </Link>
        <h1 className="text-2xl font-semibold">{rule.key}</h1>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">category: {rule.category}</p>
      </header>

      {errorParam ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {errorParam}
        </p>
      ) : null}

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Pending proposals ({proposed.length})
        </h2>
        {proposed.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Nothing waiting for a decision.</p>
        ) : (
          <ul className="flex flex-col gap-3 text-sm">
            {proposed.map((version) => (
              <VersionCard key={version.id} ruleId={rule.id} version={version} isCurrent={false} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">History ({history.length})</h2>
        {history.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No decided versions yet.</p>
        ) : (
          <ul className="flex flex-col gap-3 text-sm">
            {history.map((version) => (
              <VersionCard key={version.id} ruleId={rule.id} version={version} isCurrent={version.id === rule.currentVersionId} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
