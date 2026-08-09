import { pgTable, uuid, text, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { profiles } from "./profiles";

export const customerTypeEnum = pgEnum("customer_type", ["private", "company"]);

export const clients = pgTable("clients", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  // Set once a guest client claims/creates a login. No self-service account
  // flow exists yet — this just reserves the link for when it does.
  profileId: uuid("profile_id").references(() => profiles.id, {
    onDelete: "set null",
  }),
  customerType: customerTypeEnum("customer_type").notNull().default("private"),
  fullName: text("full_name").notNull(),
  companyName: text("company_name"),
  email: text("email"),
  phone: text("phone").notNull(),
  country: text("country"),
  preferredLanguage: text("preferred_language"),
  notes: text("notes"),
  marketingConsent: boolean("marketing_consent").notNull().default(false),
  // First-touch attribution, captured once at lead creation and never
  // overwritten. Every downstream entity (quotes, bookings) links back to
  // this via clientId rather than duplicating attribution data — see
  // packages/core/src/marketing/business-kpis.ts.
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmTerm: text("utm_term"),
  utmContent: text("utm_content"),
  gclid: text("gclid"),
  landingPage: text("landing_page"),
  referrer: text("referrer"),
  firstTouchAt: timestamp("first_touch_at", { withTimezone: true }),
  // Soft delete: never hard-delete a client (booking history integrity).
  // Queries filter this out by default — see packages/core/src/clients/service.ts.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
