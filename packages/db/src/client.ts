import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

let cached: Db | null = null;

// Lazy on purpose: importing this module must never throw at build/typecheck
// time just because DATABASE_URL isn't set yet (e.g. in CI before Phase 1).
export function getDb(): Db {
  if (cached) return cached;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  // prepare: false is required for correctness once DATABASE_URL points at a
  // transaction-mode connection pooler (Supabase's Supavisor/PgBouncer) —
  // prepared statements aren't safe to reuse across pooled connections,
  // since a later query on the "same" prepared statement can land on a
  // different physical connection. Harmless no-op on a direct connection.
  const queryClient = postgres(connectionString, { prepare: false });
  cached = drizzle(queryClient, { schema });
  return cached;
}
