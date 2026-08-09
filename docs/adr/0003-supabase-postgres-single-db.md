# 0003 — Supabase Postgres as a single shared database

**Status:** Accepted — 2026-08-06

## Context

The platform needs a database, authentication, and file storage. It currently serves one tenant (Bonolini Transfer) but is designed to serve more later.

## Decision

Use a **single Postgres database hosted on Supabase**, shared across all tenants and domain modules, with tenant isolation enforced by `tenant_id` columns plus **Postgres Row Level Security (RLS)** — not separate databases per tenant, and not app-layer-only access checks.

Supabase also provides Auth (used directly by `packages/auth`) and Storage, so a solo founder operates one vendor and one bill instead of stitching together separate DB, auth, and file-storage providers.

## Why

- One database is far cheaper to operate solo than per-tenant databases, while RLS still gives real isolation guarantees — a buggy query can't leak cross-tenant data because the database itself enforces the boundary, not just application code.
- Supabase's managed Postgres, Auth, and Storage bundle reduces the number of moving parts a solo operator has to run and monitor.

## Consequence

Migrations are the source of truth for schema (`packages/db/migrations`), and RLS policies are treated as part of the schema, not an afterthought — see `packages/db/migrations/0000_init.sql`.
