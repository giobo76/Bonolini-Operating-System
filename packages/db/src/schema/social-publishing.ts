import { pgTable, uuid, text, date, timestamp, jsonb, pgEnum, unique } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

// One row per tenant per calendar week — the real idempotency boundary for
// "at most one Facebook post per week" (see UNIQUE(tenant_id, week_start_date)
// below). week_start_date is always the Monday of the target week, computed
// from the cron's own trigger time in Europe/Rome — never re-derived from
// "now" at publish time, so a delayed retry still targets the same week
// instead of silently creating a second row for it.
export const socialPostStatusEnum = pgEnum("social_post_status", [
  "draft",
  "validated",
  "published",
  "failed",
]);

export const socialPosts = pgTable(
  "social_posts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    weekStartDate: date("week_start_date", { mode: "string" }).notNull(),
    status: socialPostStatusEnum("status").notNull().default("draft"),
    content: text("content"),
    language: text("language").notNull().default("en"),
    // The real, aggregated BOS data (served routes, transfer types, service
    // area places) the content was generated from — kept for audit so it's
    // always possible to check exactly what facts a given post was grounded
    // in. Never contains a client name, phone, email, or price — see
    // packages/core/src/social-publishing/content-source.ts.
    dataSnapshot: jsonb("data_snapshot"),
    metaPostId: text("meta_post_id"),
    metaError: text("meta_error"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantWeekUnique: unique("social_posts_tenant_week_unique").on(table.tenantId, table.weekStartDate),
  }),
);

export type SocialPost = typeof socialPosts.$inferSelect;
export type NewSocialPost = typeof socialPosts.$inferInsert;
