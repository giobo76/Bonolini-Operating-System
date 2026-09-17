import { z } from "zod";
import { DbSharedMemory } from "./db-memory";
import { redact } from "../observability";

// The operational memory API every agent actually calls (V2) — V1 created
// DbSharedMemory but nothing used it. This module is the only thing
// agents/orchestrator.ts talk to; DbSharedMemory itself stays an internal
// implementation detail (the SharedMemory-interface adapter over
// agent_memory).
//
// Deliberately NOT a log: every record is schema-validated (memoryRecordSchema
// below, summary capped at 200 chars) and every read is bounded (see
// MAX_SEARCH_RESULTS) — this is memory meant to be re-read and reasoned
// over by an agent's next Claude call, not an append-only trail (that's
// what agent_runs already is). Tenant isolation is inherited entirely from
// DbSharedMemory's own constructor contract (every call here takes an
// explicit tenantId, never a global/ambient one) — see that file's own
// header comment and its tenant-isolation tests.
//
// Auditing memory operations is the orchestrator's job, not this module's:
// orchestrator.ts records what was read/written into agent_runs.memoryOps
// after calling these functions, so there's one audit mechanism (agent_runs),
// not two competing ones.

export const memoryKinds = [
  "decision",
  "run_result",
  "open_issue",
  "resolved_issue",
  "proposed_action",
  "approval_outcome",
  "context",
] as const;
export const memoryKindSchema = z.enum(memoryKinds);
export type MemoryKind = (typeof memoryKinds)[number];

export const memoryRecordSchema = z.object({
  kind: memoryKindSchema,
  agentName: z.string().min(1),
  // Short by construction — this is what gets fed back into a future
  // Claude prompt, not a place to paste a full object dump.
  summary: z.string().min(1).max(200),
  data: z.record(z.string(), z.unknown()).optional(),
  correlationId: z.string().optional(),
  createdAt: z.string(),
});
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

const MAX_SEARCH_RESULTS = 20;
export const MAX_ROLLING_HISTORY = 10;

function memoryFor(tenantId: string): DbSharedMemory {
  return new DbSharedMemory(tenantId);
}

// Never trusts a stored value blindly, even though this module is the only
// writer — a future migration/manual edit/corrupt row is dropped rather
// than fed to an agent's prompt unchecked.
function parseStoredRecord(value: unknown): MemoryRecord | undefined {
  const result = memoryRecordSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export async function memoryGet(tenantId: string, namespace: string, key: string): Promise<MemoryRecord | undefined> {
  const entry = await memoryFor(tenantId).get(namespace, key);
  return entry ? parseStoredRecord(entry.value) : undefined;
}

export async function memorySet(
  tenantId: string,
  namespace: string,
  key: string,
  record: Omit<MemoryRecord, "createdAt">,
): Promise<MemoryRecord> {
  // Same key-pattern redaction observability.ts's log()/captureException()
  // already apply to console output, applied here too — a memory write is
  // a second persistence path secret-shaped data could otherwise leak
  // through that log-only redaction never covered.
  const full: MemoryRecord = {
    ...record,
    data: record.data ? (redact(record.data) as Record<string, unknown>) : record.data,
    createdAt: new Date().toISOString(),
  };
  // Throws on an invalid shape — a bug in a caller must fail loudly here,
  // not silently write something a future memoryGet() would then drop.
  memoryRecordSchema.parse(full);
  await memoryFor(tenantId).set(namespace, key, full);
  return full;
}

export async function memoryUpdate(
  tenantId: string,
  namespace: string,
  key: string,
  patch: Partial<Omit<MemoryRecord, "createdAt">>,
): Promise<MemoryRecord> {
  const existing = await memoryGet(tenantId, namespace, key);
  const merged: Omit<MemoryRecord, "createdAt"> = {
    kind: patch.kind ?? existing?.kind ?? "context",
    agentName: patch.agentName ?? existing?.agentName ?? "unknown",
    summary: patch.summary ?? existing?.summary ?? "",
    data: patch.data ?? existing?.data,
    correlationId: patch.correlationId ?? existing?.correlationId,
  };
  return memorySet(tenantId, namespace, key, merged);
}

export interface MemorySearchOptions {
  limit?: number;
  filter?: (record: MemoryRecord) => boolean;
}

// Always scoped to one namespace (never a cross-namespace scan) and always
// capped at MAX_SEARCH_RESULTS regardless of what a caller requests — the
// two structural guarantees that keep this "memory," not "the whole log."
export async function memorySearch(
  tenantId: string,
  namespace: string,
  options: MemorySearchOptions = {},
): Promise<MemoryRecord[]> {
  const limit = Math.min(options.limit ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
  const all = await memoryFor(tenantId).list(namespace);
  const records = Object.values(all)
    .map((entry) => parseStoredRecord(entry.value))
    .filter((record): record is MemoryRecord => record !== undefined);
  const filtered = options.filter ? records.filter(options.filter) : records;
  return filtered.slice(0, limit);
}

// Bounds a rolling history array kept inside a record's own `data` field
// (e.g. social's last N Facebook errors) — every caller that accumulates a
// list in memory must go through this, so "memory" can never silently grow
// into an unbounded log one push() at a time.
export function pushBounded<T>(list: T[] | undefined, item: T, max = MAX_ROLLING_HISTORY): T[] {
  const next = [...(list ?? []), item];
  return next.length > max ? next.slice(next.length - max) : next;
}
