# evidence

**Status:** Phase 1 of the BOS Business Intelligence + Autonomy Model — implemented.

**Owns:** `evidence` (id, tenant_id, collected_at, period_start, period_end, source, query_or_call, raw_observation, calculation, conclusion, evidence_type, confidence, created_at).

**Exposes:** `createEvidence`, `getEvidence`, `listEvidence`, `getEvidenceByIds`.

**Emits:** — (no domain events; evidence rows are created synchronously by whatever analysis produced them).

**Listens to:** — (no cross-module events; this module has no producer of its own — analyses in other modules call `createEvidence` directly).

Deliberately generic, not owned by `marketing` or any other single domain — any future analysis (Ads/GA4/SEO findings, a booking-price anomaly, an opportunity score) can record what it observed here. The first, and currently only, consumer is `business-rules` (see its own README's "Provenance" section) — linking evidence to a specific proposal/recommendation is that module's job, not this one's; this module only stores the evidence itself.

`evidence_type` (fact | calculation | hypothesis | recommendation) and `confidence` (high | medium | low) are two independent fields on purpose — never conflate them. A FACT can be reported with low confidence (an uncertain measurement); a RECOMMENDATION can be reported with high confidence (strong supporting evidence). See `packages/db/src/schema/evidence.ts`'s own header comment.

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this and every other domain module follows.
