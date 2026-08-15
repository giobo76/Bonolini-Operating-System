import { z } from "zod";

export const resourceTypeSchema = z.enum([
  "google_ads_account",
  "ga4_property",
  "gtm_container",
  "search_console_site",
]);

export const addLinkedResourceSchema = z.object({
  resourceType: resourceTypeSchema,
  externalId: z.string().trim().min(1, "Required"),
  displayName: z.string().trim().optional(),
});

export const resourceIdSchema = z.object({ id: z.string().uuid() });

export type AddLinkedResourceInput = z.infer<typeof addLinkedResourceSchema>;

// ── Findings ──────────────────────────────────────────────────────────
// The CMO-level structure the founder required, before any detection rule
// exists to populate it: every finding must carry severity, confidence,
// business impact, estimated financial impact, root cause, recommended
// actions, an approval flag, and expected benefit.

export const findingCategorySchema = z.enum([
  "conversion_tracking",
  "duplicate_conversions",
  "attribution",
  "gtm_configuration",
  "budget_pacing",
  "budget_waste",
  "bid_cpc_anomaly",
  "quality_score",
  "impression_share",
  "policy_compliance",
  "account_health",
  "landing_page_availability",
  "page_speed",
  "core_web_vitals",
  "search_console_indexing",
  "organic_traffic",
  "form_tracking",
  "call_tracking",
  "whatsapp_tracking",
  "competitor_observation",
  "other",
]);

// technical_issue = active harm (drags the Health Score down hard).
// strategic_opportunity = unrealized upside (tracked as "opportunity
// value" instead, penalizes the score much more lightly). See health-score.ts.
export const findingNatureSchema = z.enum(["technical_issue", "strategic_opportunity"]);
export const findingSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export const findingStatusSchema = z.enum(["open", "acknowledged", "resolved", "dismissed"]);

export const financialImpactSchema = z.object({
  amount: z.number().nonnegative().nullable(),
  currency: z.string().default("EUR"),
  period: z.enum(["one_time", "daily", "weekly", "monthly"]),
  direction: z.enum(["cost", "opportunity"]),
  note: z.string().optional(),
});

export const createFindingSchema = z.object({
  checkRunId: z.string().uuid().optional(),
  category: findingCategorySchema,
  nature: findingNatureSchema,
  severity: findingSeveritySchema,
  confidenceScore: z.number().int().min(0).max(100),
  title: z.string().trim().min(1),
  observation: z.string().trim().min(1),
  rootCause: z.string().trim().optional(),
  businessImpact: z.string().trim().min(1),
  financialImpact: financialImpactSchema.nullable().optional(),
  recommendedActions: z.array(z.string().trim().min(1)).default([]),
  requiresApproval: z.boolean().default(false),
  expectedBenefit: z.string().trim().optional(),
  evidence: z.record(z.unknown()).optional(),
});

export const findingIdSchema = z.object({ id: z.string().uuid() });

export const updateFindingStatusSchema = z.object({
  id: z.string().uuid(),
  status: findingStatusSchema,
});

export const listFindingsSchema = z.object({
  status: findingStatusSchema.optional(),
  severity: findingSeveritySchema.optional(),
  nature: findingNatureSchema.optional(),
  category: findingCategorySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type CreateFindingInput = z.infer<typeof createFindingSchema>;
export type ListFindingsInput = z.infer<typeof listFindingsSchema>;
export type FinancialImpact = z.infer<typeof financialImpactSchema>;

// ── Marketing leads (anonymous intent capture) ───────────────────────────
// recordLeadIntentSchema is deliberately narrow, same spirit as
// leadSubmissionSchema in packages/core/src/clients/schema.ts: a public,
// unauthenticated caller (the lead-intent endpoint, not built yet) can only
// ever record attribution metadata for a click — never a name, phone,
// email, clientId, or tenantId. Length caps only (no z.url()) because
// landingPage/referrer come from a real browser's window.location.href/
// document.referrer on an external site — strict URL parsing would reject
// legitimate edge cases (e.g. an empty referrer on direct traffic).

export const marketingLeadChannelSchema = z.enum(["whatsapp", "phone", "email", "form"]);
export const marketingLeadStatusSchema = z.enum(["new", "contacted", "converted", "discarded"]);

// .strict() (added in Phase 3, for the public HTTP endpoint): a plain
// z.object() silently strips unrecognized keys instead of rejecting them —
// wrong here, since the endpoint must actively reject a payload carrying
// tenantId/clientId/fullName/phone/email/notes/etc, not quietly ignore it.
export const recordLeadIntentSchema = z
  .object({
    channel: marketingLeadChannelSchema,
    landingPage: z.string().trim().max(2048).optional(),
    referrer: z.string().trim().max(2048).optional(),
    utmSource: z.string().trim().max(255).optional(),
    utmMedium: z.string().trim().max(255).optional(),
    utmCampaign: z.string().trim().max(255).optional(),
    utmTerm: z.string().trim().max(255).optional(),
    utmContent: z.string().trim().max(255).optional(),
    gclid: z.string().trim().max(255).optional(),
    visitorId: z.string().trim().max(128).optional(),
  })
  .strict();

export const listUnlinkedLeadsSchema = z.object({
  channel: marketingLeadChannelSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const linkLeadToClientSchema = z.object({
  marketingLeadId: z.string().uuid(),
  clientId: z.string().uuid(),
});

export type RecordLeadIntentInput = z.infer<typeof recordLeadIntentSchema>;
export type ListUnlinkedLeadsInput = z.infer<typeof listUnlinkedLeadsSchema>;
export type LinkLeadToClientInput = z.infer<typeof linkLeadToClientSchema>;
