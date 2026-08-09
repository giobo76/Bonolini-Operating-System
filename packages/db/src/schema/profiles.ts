import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

// Kept generic on purpose — the future AI Automation Agency will likely need
// its own roles. Extend this enum rather than adding a second one.
// See docs/future-agency.md.
export const roleEnum = pgEnum("role", ["admin", "dispatcher", "driver", "client"]);

export const profiles = pgTable("profiles", {
  // Same id as the corresponding auth.users row (Supabase Auth).
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  role: roleEnum("role").notNull().default("client"),
  fullName: text("full_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
