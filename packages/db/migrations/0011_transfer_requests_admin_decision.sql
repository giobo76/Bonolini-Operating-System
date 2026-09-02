-- Bonolini OS — Transfer Request admin decision (ACCEPT / REJECT / MODIFY PRICE)
--
-- Hand-authored (no Node/drizzle-kit available). Verify with `pnpm db:generate`
-- once dependencies are installed.
--
-- Context: transfer_requests.status already had 'approved' and 'cancelled'
-- values (0010_transfer_requests.sql) but nothing ever wrote them — no
-- accept/reject/modify-price path existed. Adds only what's needed to
-- persist that admin decision; no new status enum value (REJECT reuses
-- 'cancelled' + cancelled_reason = 'rejected_by_admin', per the founder's
-- explicit decision — see packages/core/src/transfer-requests/README.md's
-- "Admin decision" section for the full rationale, including why
-- calculated_amount_cents is never overwritten and final_amount_cents is
-- the one column every future consumer (quote/booking/calendar event) must
-- read instead.

alter table transfer_requests
  add column if not exists final_amount_cents integer,
  add column if not exists price_override_reason text;
