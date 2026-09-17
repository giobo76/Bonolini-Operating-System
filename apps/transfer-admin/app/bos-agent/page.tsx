import Link from "next/link";
import { TRPCError } from "@trpc/server";
import { createServerCaller } from "@bos/core";
import { PermissionDenied } from "./permission-denied";
import { approveAction, rejectAction, triggerNowAction } from "./actions";

const AGENT_NAMES = ["marketing", "social", "operations"] as const;

const KNOWN_MEMORY_NAMESPACES = [
  "marketing",
  "social",
  "operations",
  "marketing-approvals",
  "social-approvals",
  "operations-approvals",
] as const;

const STATUS_STYLES: Record<string, string> = {
  success: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
  denied: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
  pending_approval: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
  running: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

function formatDate(value: Date | string) {
  return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function DecisionDetails({ run }: { run: { decision: unknown; policyResult: unknown; perception: unknown; memoryOps: unknown; correlationId: string | null; eventType: string | null } }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-neutral-500 underline dark:text-neutral-400">
        What did the agent see, decide, and why?
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-xs">
        {run.correlationId ? (
          <div>
            <span className="text-neutral-500 dark:text-neutral-400">correlation id: </span>
            <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">{run.correlationId}</code>
            {run.eventType ? <span className="text-neutral-500 dark:text-neutral-400"> ({run.eventType})</span> : null}
          </div>
        ) : null}
        {run.decision ? (
          <div>
            <div className="text-neutral-500 dark:text-neutral-400">Decision:</div>
            <pre className="mt-1 overflow-x-auto rounded bg-neutral-50 p-2 dark:bg-neutral-900">{JSON.stringify(run.decision, null, 2)}</pre>
          </div>
        ) : null}
        {run.policyResult ? (
          <div>
            <div className="text-neutral-500 dark:text-neutral-400">Policy result (why it acted, waited, or was denied):</div>
            <pre className="mt-1 overflow-x-auto rounded bg-neutral-50 p-2 dark:bg-neutral-900">{JSON.stringify(run.policyResult, null, 2)}</pre>
          </div>
        ) : null}
        {run.memoryOps ? (
          <div>
            <div className="text-neutral-500 dark:text-neutral-400">Memory used:</div>
            <pre className="mt-1 overflow-x-auto rounded bg-neutral-50 p-2 dark:bg-neutral-900">{JSON.stringify(run.memoryOps, null, 2)}</pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

export default async function BosAgentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const triggered = sp.triggered === "1";
  const errorParam = Array.isArray(sp.error) ? sp.error[0] : sp.error;
  const memoryNamespaceParam = Array.isArray(sp.memoryNamespace) ? sp.memoryNamespace[0] : sp.memoryNamespace;
  const memoryNamespace = (KNOWN_MEMORY_NAMESPACES as readonly string[]).includes(memoryNamespaceParam ?? "")
    ? (memoryNamespaceParam as (typeof KNOWN_MEMORY_NAMESPACES)[number])
    : "social";

  const caller = await createServerCaller();

  let status, agents, tools, runs, pendingApprovals, memoryActivity;
  try {
    [status, agents, tools, runs, pendingApprovals, memoryActivity] = await Promise.all([
      caller.bosAgent.status(),
      caller.bosAgent.agents(),
      caller.bosAgent.tools(),
      caller.bosAgent.listRuns({ limit: 20 }),
      caller.bosAgent.pendingApprovals(),
      caller.bosAgent.memoryActivity({ namespace: memoryNamespace, limit: 10 }),
    ]);
  } catch (error) {
    if (error instanceof TRPCError && error.code === "FORBIDDEN") {
      return <PermissionDenied />;
    }
    throw error;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-start justify-between">
        <div>
          <Link href="/" className="text-sm text-neutral-500 underline dark:text-neutral-400">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-semibold">BOS Agent</h1>
          <p className="mt-1 max-w-xl text-xs text-neutral-500 dark:text-neutral-400">
            Central orchestrator coordinating the Marketing, Social, and Operations agents through EVENT →
            CONTEXT → MEMORY → SPECIALIST AGENT → DECISION → POLICY → ACTION/APPROVAL/NO ACTION → AUDIT → MEMORY
            UPDATE. Budget, price, and booking-mutation actions always require approval below — nothing in that
            category runs automatically.
          </p>
        </div>
      </header>

      {triggered ? (
        <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400">
          Agent run triggered.
        </p>
      ) : null}
      {errorParam ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {errorParam}
        </p>
      ) : null}

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">Status</h2>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <div className="text-xs text-neutral-500 dark:text-neutral-400">Agents</div>
            <div className="text-lg font-medium">{status.agentCount}</div>
          </div>
          <div>
            <div className="text-xs text-neutral-500 dark:text-neutral-400">Tools</div>
            <div className="text-lg font-medium">{status.toolCount}</div>
          </div>
          <div>
            <div className="text-xs text-neutral-500 dark:text-neutral-400">Pending approvals</div>
            <div className="text-lg font-medium">{status.pendingApprovalCount}</div>
          </div>
        </div>
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">Trigger an agent now</h2>
        <div className="flex gap-2">
          {AGENT_NAMES.map((name) => (
            <form key={name} action={triggerNowAction}>
              <input type="hidden" name="agentName" value={name} />
              <button type="submit" className="rounded border px-3 py-1.5 text-sm capitalize">
                Run {name}
              </button>
            </form>
          ))}
        </div>
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">Agents</h2>
        <ul className="flex flex-col gap-2 text-sm">
          {agents.map((agent) => (
            <li key={agent.id} className="rounded border p-2">
              <div className="font-medium">{agent.name}</div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400">{agent.description}</div>
              <div className="mt-1 text-xs text-neutral-400">capabilities: {agent.capabilities.join(", ")}</div>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">Registered tools (Action Registry)</h2>
        <ul className="flex flex-col gap-2 text-sm">
          {tools.map((tool) => (
            <li key={tool.name} className="rounded border p-2">
              <div className="flex items-center justify-between">
                <span className="font-medium">{tool.name}</span>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {tool.riskLevel} · {tool.requiresApproval ? "requires approval" : "auto-approved"} ·{" "}
                  {tool.reversible ? "reversible" : "irreversible"}
                </span>
              </div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400">{tool.description}</div>
              {tool.allowedAgents ? (
                <div className="mt-1 text-xs text-neutral-400">allowed agents: {tool.allowedAgents.join(", ")}</div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">
          Pending approvals ({pendingApprovals.length})
        </h2>
        {pendingApprovals.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Nothing waiting for approval.</p>
        ) : (
          <ul className="flex flex-col gap-3 text-sm">
            {pendingApprovals.map((approval) => (
              <li key={approval.id} className="rounded border p-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{approval.requestedAction}</span>
                  <span className="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300">
                    {approval.risk}
                  </span>
                </div>
                <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{approval.reason}</div>
                {approval.correlationId ? (
                  <div className="mt-1 text-xs text-neutral-400">
                    correlation id: <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">{approval.correlationId}</code>
                  </div>
                ) : null}
                {approval.payload ? (
                  <pre className="mt-2 overflow-x-auto rounded bg-neutral-50 p-2 text-xs dark:bg-neutral-900">
                    {JSON.stringify(approval.payload, null, 2)}
                  </pre>
                ) : null}
                <div className="mt-2 flex gap-2">
                  <form action={approveAction}>
                    <input type="hidden" name="id" value={approval.id} />
                    <button type="submit" className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white">
                      Approve &amp; execute
                    </button>
                  </form>
                  <form action={rejectAction}>
                    <input type="hidden" name="id" value={approval.id} />
                    <button type="submit" className="rounded border px-3 py-1.5 text-xs">
                      Reject
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No runs yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {runs.map((run) => (
              <li key={run.id} className="rounded border p-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium capitalize">{run.agentName}</span>
                  <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[run.status] ?? ""}`}>{run.status}</span>
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {run.trigger} · {formatDate(run.startedAt)}
                  {run.toolName ? ` · ${run.toolName}` : ""}
                </div>
                {run.error ? <div className="mt-1 text-xs text-red-600 dark:text-red-400">{run.error}</div> : null}
                <DecisionDetails run={run} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">Memory activity</h2>
        <div className="mb-3 flex flex-wrap gap-2">
          {KNOWN_MEMORY_NAMESPACES.map((ns) => (
            <Link
              key={ns}
              href={`/bos-agent?memoryNamespace=${ns}`}
              className={`rounded border px-2 py-1 text-xs ${ns === memoryNamespace ? "bg-neutral-900 text-white" : ""}`}
            >
              {ns}
            </Link>
          ))}
        </div>
        {memoryActivity.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Nothing remembered yet in &quot;{memoryNamespace}&quot;.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {memoryActivity.map((record, i) => (
              <li key={i} className="rounded border p-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase text-neutral-500 dark:text-neutral-400">{record.kind}</span>
                  <span className="text-xs text-neutral-400">{formatDate(record.createdAt)}</span>
                </div>
                <div className="mt-1">{record.summary}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
