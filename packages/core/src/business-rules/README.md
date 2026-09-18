# business-rules

**Status:** Phase 1 of the BOS Business Intelligence + Autonomy Model — implemented, plus a governance revision: the BOS may now propose an entirely new rule (`proposeNewBusinessRule`), not only a new version of one that already exists. Foundations only: the versioned rule store, its strict state machine, and the admin approval UI. No agent reads or writes through this module yet (Marketing/Social/Operations Agents, pricing at runtime, and the Opportunity Priority Engine are all explicitly out of scope for this phase — see the phase's own approval message).

**Owns:** `business_rules` (id, tenant_id, key, category, current_version_id, created_at, updated_at) and `business_rule_versions` (id, tenant_id, rule_id, version_number, status, content, author, proposal_reasoning, owner_decision, owner_decision_reason, decided_by, decided_at, effective_from, created_at). Also `business_rule_version_evidence`, the many-to-many join to `evidence` (see the `evidence` module).

**Exposes:** `businessRulesRouter` (admin-only tRPC: `list`, `get`, `create`, `approve`, `reject`) plus service functions `createBusinessRule`, `listBusinessRules`, `getBusinessRule`, `proposeBusinessRuleVersion`, `proposeNewBusinessRule`, `linkEvidenceToVersion`, `approveBusinessRuleVersion`, `rejectBusinessRuleVersion`.

**Emits:** — (no domain events this phase; a future phase may add one, e.g. for the notification system Section B of the gap analysis calls out as still unimplemented).

**Listens to:** — (nothing yet; a future BOS-agent analysis will call `proposeBusinessRuleVersion` directly, service-to-service, once one exists).

## Governance — who can do what

> Le business rules ufficiali appartengono esclusivamente al titolare.

Concretely, in this code:

| Actor | Can | Cannot |
|---|---|---|
| Founder (admin) | Create a rule (`createBusinessRule`); approve a proposal (`approve` — also makes it effective in the same call, see below); reject a proposal, with a required reason | — |
| BOS (any future agent) | Read rules/versions/evidence (`list`/`get`); propose a new version of an existing rule (`proposeBusinessRuleVersion`) *or* an entirely new rule for an opportunity that fits no existing key (`proposeNewBusinessRule`) — both always produce `status="proposed"`; attach evidence to its own still-`proposed` version (`linkEvidenceToVersion`) | Make any rule (new or existing) official — no path sets a version to `approved`/`rejected`/`effective`/`superseded`, and `proposeNewBusinessRule` never sets `business_rules.current_version_id`; modify a version's `content`/`author`/`proposalReasoning` after creation, ever; modify a version once it has been decided, for any reason |

Neither `proposeBusinessRuleVersion` nor `proposeNewBusinessRule` is wired to a tRPC mutation — see `router.ts`'s own header comment. Both are entry points a future agent calls directly (the same way `orchestrator.ts` calls `audit.ts`/`approvals.ts`/`memory.ts` directly, never through a human-facing router), and both are structurally incapable of producing anything other than a `proposed` row — there is no parameter, no code path, that lets a caller pick a different starting status. A BOS-proposed brand-new rule is exactly as unauthoritative as a BOS-proposed version of an existing one: a `business_rules` row's mere existence has never been what makes it official in this design — only `current_version_id` being set does, and that only ever happens via `approveBusinessRuleVersion`.

## State machine

```
proposed --(approve)--> approved --(same call)--> effective
proposed --(reject)-->  rejected
(the rule's previous "effective" version) --> superseded
    -- only as a side effect of a *different* version becoming effective, never a direct action
```

`approved` is a real, independently validated state internally (see `service.ts`'s `approveBusinessRuleVersion`), but Phase 1's UI only exposes one "APPROVA" action that performs both transitions atomically — there is no requirement yet to approve now and activate on a future date. The enum and the two internal guard clauses exist so a later phase could split them into two separate calls without any schema change.

Every transition function re-checks the version's current status before touching it — no transition is ever assumed. Calling `approve` on an already-`effective` version, or `reject` on an already-`rejected` version, is a safe no-op (idempotent). Calling either on a version already decided the *other* way (e.g. `approve` on a `rejected` version) throws.

## Provenance

A version's supporting evidence is a many-to-many relationship (`business_rule_version_evidence`), not a single scalar column — one proposal can cite several observations, and one observation (e.g. one Google Ads query result) can support more than one proposal over time. `getBusinessRule` returns each version with its real evidence rows attached (not just ids), so a recommendation can be reconstructed end to end: rule content → the founder's or BOS's own reasoning → the actual FACT/CALCULATION/HYPOTHESIS rows behind it. See the `evidence` module's own README for the FACT/CALCULATION/HYPOTHESIS/RECOMMENDATION distinction.

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this and every other domain module follows.
