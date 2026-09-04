import { pgTable, uuid, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

export const calendarSyncStatusEnum = pgEnum("calendar_sync_status", ["ok", "error"]);

// One row per tenant (unique tenantId) — the Google Calendar explicitly
// selected as "the Bonolini Transfer services calendar." Never all of the
// user's personal calendars — see packages/core/src/calendar/README.md.
// Reuses the existing Google OAuth connection (marketing_connections) for
// the actual credential; this table only holds which calendar was chosen
// and this module's own sync bookkeeping.
export const calendarConnections = pgTable("calendar_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  googleCalendarId: text("google_calendar_id").notNull(),
  googleCalendarName: text("google_calendar_name"),
  timezone: text("timezone"),
  // Google Calendar's incremental-sync token (events.list's nextSyncToken).
  // Null means "do a full sync next time" — either never synced yet, or the
  // previous token was invalidated (Google returns 410 Gone) and this
  // module cleared it to force a controlled full resync. Never combined
  // with a timeMin filter once a syncToken is in use (Google's API forbids
  // that combination).
  syncToken: text("sync_token"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastSyncStatus: calendarSyncStatusEnum("last_sync_status"),
  lastSyncError: text("last_sync_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CalendarConnection = typeof calendarConnections.$inferSelect;
export type NewCalendarConnection = typeof calendarConnections.$inferInsert;
