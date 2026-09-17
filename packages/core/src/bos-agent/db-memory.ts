import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, agentMemory } from "@bos/db";
import type { SharedMemory, SharedMemoryEntry } from "@bos/ai";

// Production replacement for @bos/ai's InMemorySharedMemory — that
// implementation loses all state between Vercel serverless invocations
// (each lambda gets its own process), which makes it unsafe for anything
// the orchestrator needs to remember across runs. Same SharedMemory
// interface, so orchestrator.ts and every agent handler need no changes to
// use this instead — only the OrchestratorOptions.memory value passed in
// registry-instance.ts changes.
//
// Tenant-scoped by construction: every query is always additionally
// filtered by tenantId, on top of (namespace, key) — the same discipline
// every other table/service in this codebase already follows (ADR 0004).
// One tenant can never read or write another tenant's memory through this
// class, regardless of what namespace/key string is passed in.
export class DbSharedMemory implements SharedMemory {
  constructor(private readonly tenantId: string) {}

  async get(namespace: string, key: string): Promise<SharedMemoryEntry | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(agentMemory)
      .where(and(eq(agentMemory.tenantId, this.tenantId), eq(agentMemory.namespace, namespace), eq(agentMemory.key, key)));
    const row = rows[0];
    if (!row) return undefined;
    return { value: row.value, updatedAt: row.updatedAt.toISOString() };
  }

  async set(namespace: string, key: string, value: unknown): Promise<void> {
    const db = getDb();
    await db
      .insert(agentMemory)
      .values({ tenantId: this.tenantId, namespace, key, value: value as object })
      .onConflictDoUpdate({
        target: [agentMemory.tenantId, agentMemory.namespace, agentMemory.key],
        set: { value: value as object, version: sql`${agentMemory.version} + 1`, updatedAt: new Date() },
      });
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .delete(agentMemory)
      .where(and(eq(agentMemory.tenantId, this.tenantId), eq(agentMemory.namespace, namespace), eq(agentMemory.key, key)))
      .returning();
    return rows.length > 0;
  }

  // Most-recently-updated first — callers that bound this list to a small
  // limit (see memory.ts's memorySearch) rely on that order to mean "most
  // recent", not an arbitrary slice of however many rows happen to exist.
  async list(namespace: string): Promise<Record<string, SharedMemoryEntry>> {
    const db = getDb();
    const rows = await db
      .select()
      .from(agentMemory)
      .where(and(eq(agentMemory.tenantId, this.tenantId), eq(agentMemory.namespace, namespace)))
      .orderBy(desc(agentMemory.updatedAt));
    return Object.fromEntries(rows.map((row) => [row.key, { value: row.value, updatedAt: row.updatedAt.toISOString() }]));
  }
}
