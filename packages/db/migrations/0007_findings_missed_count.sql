-- Bonolini OS — Marketing Intelligence Engine: findings auto-resolution
--
-- Hand-authored, consistent with 0002-0006 (see their headers) — this
-- environment still doesn't run `drizzle-kit generate`/`migrate` against a
-- live database as part of this change, and packages/db/migrations/meta/ is
-- deliberately left untouched. Verify with `pnpm db:generate` once applied
-- against a real connection.
--
-- Context: supports auto-resolution of findings that stop being detected —
-- see packages/core/src/marketing/run-check.ts's coverage-matrix-driven
-- lifecycle logic. missed_count counts consecutive covered-and-completed
-- check runs in which an open finding's dedupeKey was not re-detected;
-- reaching 2 auto-resolves it (see AUTO_RESOLVE_AFTER_MISSES). Purely
-- additive: default 0 leaves every existing row's current behavior
-- unchanged until the new orchestration logic starts incrementing it.
-- No other column, enum, or table is touched.

alter table findings add column if not exists missed_count smallint not null default 0;
