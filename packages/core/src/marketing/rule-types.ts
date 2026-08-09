import type { CreateFindingInput } from "./schema";

// What every check function returns. `checkRunId` gets filled in by the
// orchestrator (run-check.ts), not by individual checks. `dedupeKey` lets
// the orchestrator recognize "this is the same ongoing issue" across
// repeated quick-checks instead of creating a duplicate finding every 4
// hours — it's stored in evidence.dedupeKey once persisted.
export type FindingDraft = Omit<CreateFindingInput, "checkRunId"> & {
  dedupeKey: string;
};
