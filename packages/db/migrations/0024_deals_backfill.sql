-- Bonolini OS — BOS Business Intelligence + Autonomy Model, Phase 2.5:
-- conservative deals backfill for historical data
--
-- Data-only migration (0023 already created every table/column this one
-- writes to). Deliberately conservative, per the founder-approved design:
-- ONE new deal per EXISTING transfer_request, never a retroactive merge of
-- several transfer_requests into one deal — reclustering historical
-- duplicates (e.g. the real TR2/TR3/TR4 chain from the 2026-09-18
-- incident) would require a similarity heuristic applied to real
-- production data, which is exactly the kind of judgment call this
-- migration deliberately does NOT make on its own. The benefit of the new
-- deal-aware matching (packages/core/src/deals) applies to messages
-- received AFTER this migration; nothing here changes what already
-- happened.
--
-- Idempotent: every statement is scoped to rows that don't have a deal_id
-- yet, so re-running this file (or applying it a second time by mistake)
-- is a safe no-op the second time.
--
-- Deal status is derived directly from the transfer_request's own status
-- at backfill time (no new judgment call — the mapping mirrors the
-- forward-only deal_status progression packages/core/src/deals/service.ts
-- itself uses): collecting_info/ready_for_pricing -> open,
-- pending_admin_approval -> quoted, approved/converted_to_quote ->
-- confirmed, cancelled/expired -> cancelled. last_message_at is seeded
-- from the transfer_request's own updated_at — the best deterministic
-- proxy available without inventing a "last real WhatsApp message"
-- heuristic across possibly several whatsapp_messages rows.
--
-- MATERIALIZED forces the mapping CTE to be evaluated exactly once — a
-- plain (non-materialized) CTE referencing a volatile function
-- (gen_random_uuid()) could otherwise be inlined into both consumers below
-- and re-evaluated per reference, breaking the 1:1 id correspondence this
-- migration depends on.

WITH mapping AS MATERIALIZED (
  SELECT
    id AS transfer_request_id,
    gen_random_uuid() AS new_deal_id,
    tenant_id,
    client_id,
    status,
    created_at,
    updated_at
  FROM transfer_requests
  WHERE deal_id IS NULL
),
inserted_deals AS (
  INSERT INTO deals (id, tenant_id, client_id, status, last_message_at, created_at, updated_at)
  SELECT
    new_deal_id,
    tenant_id,
    client_id,
    (CASE status
      WHEN 'collecting_info' THEN 'open'
      WHEN 'ready_for_pricing' THEN 'open'
      WHEN 'pending_admin_approval' THEN 'quoted'
      WHEN 'approved' THEN 'confirmed'
      WHEN 'converted_to_quote' THEN 'confirmed'
      WHEN 'cancelled' THEN 'cancelled'
      WHEN 'expired' THEN 'cancelled'
    END)::deal_status,
    updated_at,
    created_at,
    updated_at
  FROM mapping
  RETURNING id
)
UPDATE transfer_requests tr
SET deal_id = mapping.new_deal_id
FROM mapping
WHERE tr.id = mapping.transfer_request_id;

-- whatsapp_messages: linked only through the deterministic join each
-- message already carries (transfer_request_id -> transfer_requests.deal_id,
-- now populated by the step above). A message never routed through
-- transfer-requests matching at all (non-text, test messages — see
-- whatsapp_messages' own header comment) has no transfer_request_id and is
-- deliberately left with deal_id NULL — there is no deterministic link to
-- backfill it from, and this migration does not guess one.
UPDATE whatsapp_messages wm
SET deal_id = tr.deal_id
FROM transfer_requests tr
WHERE wm.transfer_request_id = tr.id
  AND wm.deal_id IS NULL
  AND tr.deal_id IS NOT NULL;

-- bookings: same deterministic join, via the transfer_request_id every
-- booking created by ensureBookingForApprovedTransferRequest already
-- carries. A booking created via the pre-existing manual createBooking()
-- or Calendar Sync paths has no transfer_request_id and is left NULL for
-- the same reason as above.
UPDATE bookings b
SET deal_id = tr.deal_id
FROM transfer_requests tr
WHERE b.transfer_request_id = tr.id
  AND b.deal_id IS NULL
  AND tr.deal_id IS NOT NULL;

-- quotes: deliberately NOT backfilled — quotes carries no
-- transfer_request_id (see packages/db/src/schema/quotes.ts's own header
-- comment: "Minimal skeleton", no trip-detail/request link), so there is
-- no deterministic join to backfill deal_id from. Every pre-Phase-2.5 quote
-- keeps deal_id NULL; only quotes created going forward through
-- transfer-requests' ACCEPT/MODIFY_PRICE (packages/core/src/transfer-requests/
-- service.ts) get one.
