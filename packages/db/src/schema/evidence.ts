import { pgTable, uuid, text, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

// Generalized evidence/provenance store — BOS Business Intelligence +
// Autonomy Model, Phase 1. Deliberately not owned by any one domain module
// (not "marketing evidence", not "pricing evidence"): any future analysis
// (Ads/GA4/SEO findings, a booking-price anomaly, an opportunity score) can
// record what it observed here, then reference it from wherever that
// analysis's own conclusion lives — starting with business_rule_versions
// (see business-rules.ts), but not exclusive to it.

// Epistemic type of this row's content — kept as its own field, deliberately
// NOT named/conflated with "confidence": a FACT can be reported with low
// confidence (an uncertain measurement) and a RECOMMENDATION can be reported
// with high confidence (strong supporting evidence) — these are two
// independent axes, never collapsed into one field.
export const evidenceTypeEnum = pgEnum("evidence_type", ["fact", "calculation", "hypothesis", "recommendation"]);

export const evidenceConfidenceEnum = pgEnum("evidence_confidence", ["high", "medium", "low"]);

export const evidence = pgTable("evidence", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  // When the underlying observation happened/was collected — may predate
  // this row's own insertion (createdAt) if evidence is gathered in a batch
  // or backfilled from an already-run check.
  collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
  // The time window the observation covers, if any (e.g. "last 7 days").
  // Nullable: a single point-in-time snapshot (e.g. one API call's result)
  // has no meaningful period.
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  // Where this came from — e.g. "google_ads_api", "internal_db.bookings",
  // "search_console_api". Free text, not an enum: new sources are expected
  // to appear often as new analyses are added (same reasoning agent.ts's
  // agentRuns.agentName/toolName already documents for this codebase).
  source: text("source").notNull(),
  // The exact query/API call executed, if any (e.g. a GAQL string, a DB
  // filter, an HTTP request shape) — never free-text prose, always the real
  // machine-readable call, so it can be re-run to verify the observation.
  queryOrCall: jsonb("query_or_call"),
  // FACT — the observation itself, never transformed. Required: an
  // evidence row with no observation is not evidence.
  rawObservation: jsonb("raw_observation").notNull(),
  // CALCULATION — how a derived value was produced from rawObservation, if
  // this row represents a calculation rather than a raw fact. Nullable: a
  // pure FACT row has no calculation step.
  calculation: jsonb("calculation"),
  // The conclusion this specific row supports — always required, even for
  // a plain FACT (e.g. "organic clicks dropped 62% week over week").
  conclusion: text("conclusion").notNull(),
  evidenceType: evidenceTypeEnum("evidence_type").notNull(),
  confidence: evidenceConfidenceEnum("confidence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Evidence = typeof evidence.$inferSelect;
export type NewEvidence = typeof evidence.$inferInsert;
