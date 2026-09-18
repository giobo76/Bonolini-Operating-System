import { z } from "zod";

export const evidenceTypeSchema = z.enum(["fact", "calculation", "hypothesis", "recommendation"]);
export const evidenceConfidenceSchema = z.enum(["high", "medium", "low"]);

// Mirrors packages/db/src/schema/evidence.ts exactly. queryOrCall/
// rawObservation/calculation are z.unknown() (not z.record) because a real
// query/observation can legitimately be an array (e.g. a list of GA4 rows),
// not only an object.
export const createEvidenceSchema = z.object({
  collectedAt: z.coerce.date().optional(),
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
  source: z.string().trim().min(1),
  queryOrCall: z.unknown().optional(),
  rawObservation: z.unknown(),
  calculation: z.unknown().optional(),
  conclusion: z.string().trim().min(1),
  evidenceType: evidenceTypeSchema,
  confidence: evidenceConfidenceSchema,
});

export const evidenceIdSchema = z.object({ id: z.string().uuid() });

export type CreateEvidenceInput = z.infer<typeof createEvidenceSchema>;
