# clients

**Status:** implemented (Customer Management). CRUD + search/filter + soft delete are live; consent records and GDPR export/delete are not built yet (still Phase 2).

**Owns:** client profiles and contact info (`tenant_id, profile_id, customer_type, full_name, company_name, email, phone, country, preferred_language, notes, marketing_consent, deleted_at`). GDPR consent records (a separate `consent_records` entity, per docs/domain/01-business-entities.md) are not implemented yet — `marketing_consent` today is a single boolean on the client row, not an auditable grant/revoke log.

**Exposes:** `clients.list`, `clients.get`, `clients.create`, `clients.update`, `clients.softDelete`, `clients.restore` (see `router.ts`). Soft delete only — rows are never hard-deleted.

**Emits:** —

**Listens to:** —

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this and every other domain module follows.
