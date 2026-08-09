# Roles & Permissions

Builds on the `role` enum already defined in Phase 0 (`packages/db/src/schema/profiles.ts`): `admin | dispatcher | driver | client`. This document defines what each role can actually do — Phase 0 only established *who* a user is, not what they're allowed to touch.

## Role summary

| Role | Who | Scope |
|---|---|---|
| `admin` | Founder / senior ops | Full access to everything within the tenant. |
| `dispatcher` | Ops staff handling day-to-day bookings/dispatch | Bookings, dispatch, drivers, clients. **Not** billing/invoicing configuration or driver onboarding approval (see matrix). |
| `driver` | Drivers | Only their own assigned bookings and their own profile/vehicle. |
| `client` | Registered clients | Only their own bookings and their own profile. |

Note: `dispatcher` having *narrower* access than `admin` is a real distinction this schema needs to enforce — Phase 0's RLS only isolates by `tenant_id` (see [ADR 0004](../adr/0004-tenant-id-multitenancy.md)), it does **not** yet distinguish `admin` from `dispatcher`, or scope `driver`/`client` down to their own rows. **This is a required Phase 1 schema addition** (new RLS policies per table, plus app-layer checks via `requireRole()` from `packages/auth`), not something already covered by the Phase 0 foundation.

## Permission matrix

| Resource | admin | dispatcher | driver | client |
|---|---|---|---|---|
| View all bookings (tenant-wide) | ✅ | ✅ | ❌ (own only) | ❌ (own only) |
| Create/edit booking | ✅ | ✅ | ❌ | ✅ (own) |
| Cancel booking | ✅ | ✅ | ❌ | ✅ (own, subject to cancellation policy) |
| Assign/reassign driver (dispatch) | ✅ | ✅ | ❌ | ❌ |
| Update own trip status (`en_route`/`arrived`/`in_progress`/`completed`) | ✅ | ✅ | ✅ (own assigned bookings only) | ❌ |
| View all drivers | ✅ | ✅ | ❌ | ❌ |
| Onboard/approve driver (`pending → active`) | ✅ | ❌ | ❌ | ❌ |
| Suspend/offboard driver | ✅ | ❌ | ❌ | ❌ |
| Edit own driver profile/vehicle | ✅ | ❌ | ✅ (own) | ❌ |
| View all clients | ✅ | ✅ | ❌ | ❌ |
| Edit client record | ✅ | ✅ | ❌ | ✅ (own profile fields only) |
| Blocklist a client | ✅ | ❌ | ❌ | ❌ |
| View/edit rate cards | ✅ | ❌ | ❌ | ❌ |
| Manual price override on a booking | ✅ | ✅ (with reason, per [Pricing Engine](05-pricing-engine.md)) | ❌ | ❌ |
| Issue/view invoices | ✅ | ❌ (view only, not issue) | ❌ | ✅ (own invoices only) |
| Process refunds | ✅ | ❌ | ❌ | ❌ |
| View notification log | ✅ | ✅ | ❌ | ❌ |

This matrix is the source of truth for both the RLS policies (`packages/db`) and the app-layer `requireRole()` guards (`packages/auth`) that Phase 1 adds — the two must agree with each other and with this table. If a permission changes, update this document first, then the code, not the other way around.

## Enforcement layering

Consistent with the [security strategy](../../CLAUDE.md) established at the start of this project, tenant isolation and authorization are enforced in layers. Today, the application layer (`staffProcedure`/`adminProcedure` in `packages/core/src/trpc.ts`) is the primary enforcement boundary for role checks, while database-level RLS remains a defense-in-depth mechanism rather than the sole enforcement point. This distinction is intentionally documented so future procedures do not incorrectly assume that RLS alone is the security boundary.

## Corporate account users

A corporate client may have multiple people booking on the same account (e.g. several employees, one shared billing arrangement). Phase 1 does **not** model multi-user corporate accounts — each `clients` row is a single contact. A shared corporate account with multiple authorized bookers is a plausible Phase 2+ extension (would need a join table between `profiles` and a `client` acting as the billing entity) — not designed further here since it's speculative until a real corporate client asks for it.
