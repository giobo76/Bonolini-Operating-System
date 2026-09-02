-- Bonolini OS — Transfer Request Availability connection
--
-- Hand-authored (no Node/drizzle-kit available). Verify with `pnpm db:generate`
-- once dependencies are installed.
--
-- Context: the Availability engine (packages/core/src/availability, Core v1
-- — pure, no I/O) is now connected to transfer_requests, running between
-- Maps one-way duration resolution and the pricing engine, before
-- pending_admin_approval. These two columns are where its output lands:
-- customer_trip_duration_minutes (the one-way pickup->destination drive
-- time, needed later by the Booking Snapshot milestone — never the
-- round-trip total pricing_breakdown.distance_lookup already carries, a
-- different and structurally incompatible convention) and
-- availability_breakdown (a structured, admin-explainable feasibility
-- result, symmetric to pricing_breakdown). Never blocks status progression
-- — see packages/core/src/transfer-requests/README.md's "Availability"
-- section for the full rationale.

alter table transfer_requests
  add column if not exists customer_trip_duration_minutes integer,
  add column if not exists availability_breakdown jsonb;
