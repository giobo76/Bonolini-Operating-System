-- Bonolini OS — Booking Snapshot (transfer_request -> booking)
--
-- Hand-authored (no Node/drizzle-kit available). Verify with `pnpm db:generate`
-- once dependencies are installed.
--
-- Context: ACCEPT and MODIFY_PRICE on a transfer_request (0011) now create a
-- confirmed booking as a historical snapshot of the approved service —
-- see packages/core/src/bookings/service.ts::ensureBookingForApprovedTransferRequest
-- and packages/core/src/transfer-requests/README.md's "Booking Snapshot"
-- section for the full rationale. transfer_request_id is unique so a given
-- transfer_request can never produce more than one booking (the idempotency
-- guarantee ACCEPT/MODIFY_PRICE retries rely on) — a standard (non-partial)
-- unique constraint is sufficient here because Postgres never considers two
-- NULLs equal, so bookings created via the pre-existing createBooking() path
-- (no transfer_request_id) never conflict with each other.
--
-- pickup/destination/pickup_address/destination_address/
-- customer_trip_duration_minutes stay nullable at the DDL level only for
-- pre-existing rows created via createBooking() (which has no route to know
-- these) — ensureBookingForApprovedTransferRequest always populates
-- pickup/destination/customer_trip_duration_minutes itself, enforced in the
-- service layer, not the DDL, same discipline as transfer_requests'
-- calculated_amount_cents/final_amount_cents split.

alter table bookings
  add column if not exists transfer_request_id uuid references transfer_requests (id) on delete set null,
  add column if not exists pickup text,
  add column if not exists destination text,
  add column if not exists pickup_address text,
  add column if not exists destination_address text,
  add column if not exists customer_trip_duration_minutes integer;

-- A unique constraint already creates its own backing index — no separate
-- create index needed alongside it.
alter table bookings
  add constraint bookings_transfer_request_id_key unique (transfer_request_id);
