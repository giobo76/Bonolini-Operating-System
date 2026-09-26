-- Bonolini OS — deposit before confirmation
--
-- Hand-written to match `pnpm --filter @bos/db run generate` output style
-- (drizzle-kit's own snapshot bookkeeping is stale past migration 0009 —
-- same caveat every migration since 0018 documents). Purely additive: two
-- new enum values, one nullable column. Requires 0028.
--
-- A booking created by approving a quote now starts at 'pending_deposit'
-- and becomes 'confirmed' only when the founder records the deposit
-- (WhatsApp button ACCONTO RICEVUTO, or the admin panel). Existing rows
-- are untouched. Founder decision 2026-09-26: only foreign customers pay a
-- deposit; an italian customer's booking starts at 'pending_confirmation'
-- and is confirmed with "Confermato dal cliente". The new values are not
-- used anywhere in this migration, so adding them inside the migrator's
-- transaction is safe (PostgreSQL 12+).

ALTER TYPE "public"."booking_status" ADD VALUE IF NOT EXISTS 'pending_deposit' BEFORE 'confirmed';--> statement-breakpoint
ALTER TYPE "public"."booking_status" ADD VALUE IF NOT EXISTS 'pending_confirmation' BEFORE 'confirmed';--> statement-breakpoint
ALTER TABLE "quote_approval_requests" ADD COLUMN "proposed_deposit_cents" integer;
