import { defineConfig } from "drizzle-kit";

// drizzle-kit (migrations/introspection) needs a direct, session-mode
// connection — transaction-mode pooled connections (what DATABASE_URL now
// points at, see src/client.ts) don't reliably support the multi-statement
// DDL and advisory locks drizzle-kit uses. DIRECT_URL is Supabase's direct
// (non-pooled) connection string; DATABASE_URL is kept as a fallback so this
// still works for anyone who hasn't split the two yet.
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "",
  },
});
