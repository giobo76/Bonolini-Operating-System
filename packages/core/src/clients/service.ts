import { and, count, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb, clients, tenants, assertOne, type Client } from "@bos/db";
import type { CreateClientInput, LeadSubmissionInput, ListClientsInput, UpdateClientInput } from "./schema";

// BOS is single-tenant in practice today (only "bonolini-transfer" is
// seeded — see ADR 0004 and docs/domain/README.md). Public, unauthenticated
// entry points like the lead-capture form have no session to read a
// tenantId from, so resolve it explicitly by slug rather than assuming
// "the first row." Revisit when a second tenant (the AI Automation Agency)
// exists and transfer-web needs real per-domain tenant routing.
async function getDefaultTenantId(): Promise<string> {
  const db = getDb();
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, "bonolini-transfer"));
  if (!tenant) {
    throw new Error('Default tenant "bonolini-transfer" not found — was 0000_init.sql applied?');
  }
  return tenant.id;
}

export async function listClients(tenantId: string, input: ListClientsInput) {
  const db = getDb();

  const where = and(
    eq(clients.tenantId, tenantId),
    input.status === "active" ? isNull(clients.deletedAt) : undefined,
    input.status === "archived" ? isNotNull(clients.deletedAt) : undefined,
    input.customerType ? eq(clients.customerType, input.customerType) : undefined,
    input.country ? eq(clients.country, input.country) : undefined,
    input.search
      ? or(
          ilike(clients.fullName, `%${input.search}%`),
          ilike(clients.companyName, `%${input.search}%`),
          ilike(clients.email, `%${input.search}%`),
          ilike(clients.phone, `%${input.search}%`),
        )
      : undefined,
  );

  const [rows, totalResult] = await Promise.all([
    db
      .select()
      .from(clients)
      .where(where)
      .orderBy(desc(clients.createdAt))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize),
    db.select({ total: count() }).from(clients).where(where),
  ]);

  return {
    rows,
    total: Number(totalResult[0]?.total ?? 0),
    page: input.page,
    pageSize: input.pageSize,
  };
}

export async function getClient(tenantId: string, id: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, id)));
  return row ?? null;
}

export async function createClient(tenantId: string, input: CreateClientInput) {
  const db = getDb();
  const rows = await db
    .insert(clients)
    .values({ tenantId, ...input })
    .returning();
  return assertOne(rows, "createClient");
}

export async function updateClient(tenantId: string, input: UpdateClientInput) {
  const db = getDb();
  const { id, ...data } = input;
  const [row] = await db
    .update(clients)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, id)))
    .returning();
  return row ?? null;
}

export async function softDeleteClient(tenantId: string, id: string) {
  const db = getDb();
  const [row] = await db
    .update(clients)
    .set({ deletedAt: new Date() })
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, id)))
    .returning();
  return row ?? null;
}

export async function restoreClient(tenantId: string, id: string) {
  const db = getDb();
  const [row] = await db
    .update(clients)
    .set({ deletedAt: null })
    .where(and(eq(clients.tenantId, tenantId), eq(clients.id, id)))
    .returning();
  return row ?? null;
}

// Public, unauthenticated entry point (transfer-web's "Request a Quote"
// form). No dedupe against an existing client with the same email/phone —
// see docs/domain/04-customer-lifecycle.md's note that guest-account
// matching needs its own careful design; a duplicate lead today just means
// two clients rows, not a data-integrity problem, so it's deferred rather
// than rushed.
export async function submitLead(input: LeadSubmissionInput) {
  const db = getDb();
  const tenantId = await getDefaultTenantId();
  const now = new Date();

  const rows = await db
    .insert(clients)
    .values({
      tenantId,
      customerType: "private",
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
      notes: input.message ? `Initial inquiry: ${input.message}` : undefined,
      marketingConsent: false,
      utmSource: input.utmSource,
      utmMedium: input.utmMedium,
      utmCampaign: input.utmCampaign,
      utmTerm: input.utmTerm,
      utmContent: input.utmContent,
      gclid: input.gclid,
      landingPage: input.landingPage,
      firstTouchAt: now,
    })
    .returning();
  return assertOne(rows, "submitLead");
}

// ── Find-or-create by phone (atomic) ─────────────────────────────────────
// A second, independent caller (packages/core/src/calendar's event sync)
// needs the exact same "match a client by phone, or create one" primitive
// packages/core/src/whatsapp/service.ts already implements privately as
// findOrCreateClientByPhone. Deliberately NOT extracted from there and
// reused (that would mean refactoring already-shipped, already-tested,
// production-critical WhatsApp intake code under this milestone, for a
// second caller's convenience — a real regression risk for zero benefit,
// since the two call sites need different fallback fullName behavior:
// WhatsApp defaults to the phone number itself when profileName is
// unavailable, Calendar always has a real name from the event). Exported
// here instead, in clients — the module that actually owns "what makes a
// client" — as a clean, independently tested primitive for any future
// caller, using the exact same atomic technique (same partial functional
// unique index, 0009_clients_phone_unique_per_tenant.sql) so a concurrent
// sync/webhook can never create two clients rows for the same phone.
export function normalizeClientPhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

export async function findClientByPhone(tenantId: string, phone: string): Promise<Client | null> {
  const normalizedPhone = normalizeClientPhone(phone);
  const db = getDb();
  const rows = await db
    .select()
    .from(clients)
    .where(
      and(
        eq(clients.tenantId, tenantId),
        isNull(clients.deletedAt),
        sql`regexp_replace(${clients.phone}, '[^0-9]', '', 'g') = ${normalizedPhone}`,
      ),
    )
    .orderBy(desc(clients.createdAt));
  return rows[0] ?? null;
}

export interface NewClientAttribution {
  gclid?: string | null;
  utmSource?: string | null;
  utmCampaign?: string | null;
}

export async function findOrCreateClientByPhone(
  tenantId: string,
  phone: string,
  fullName: string,
  firstTouchAt: Date,
  attribution?: NewClientAttribution,
): Promise<Client> {
  const normalizedPhone = normalizeClientPhone(phone);
  const db = getDb();

  // Attribution values only ever apply to the INSERT branch (a brand-new
  // client) — on conflict, the existing row's own first-touch data (or
  // lack of it) is never touched, same "captured once, never overwritten"
  // rule clients.gclid/utmSource already document at the schema level.
  const insertedRows = await db.execute<Client>(sql`
    insert into clients (
      tenant_id, customer_type, full_name, phone, marketing_consent, first_touch_at,
      gclid, utm_source, utm_campaign
    )
    values (
      ${tenantId},
      'private',
      ${fullName},
      ${normalizedPhone},
      false,
      ${firstTouchAt.toISOString()},
      ${attribution?.gclid ?? null},
      ${attribution?.utmSource ?? null},
      ${attribution?.utmCampaign ?? null}
    )
    on conflict (tenant_id, (regexp_replace(phone, '[^0-9]', '', 'g'))) where deleted_at is null
    do nothing
    returning *
  `);

  if (insertedRows.length > 0) {
    return insertedRows[0] as Client;
  }

  const existing = await findClientByPhone(tenantId, normalizedPhone);
  if (!existing) {
    // Unreachable in practice: a conflict on the partial unique index means
    // a matching, non-deleted client row exists. Guarded rather than
    // silently swallowed, same discipline as every other
    // insert-then-conflict-fallback in this codebase.
    throw new Error("findOrCreateClientByPhone: insert conflicted but no matching client was found");
  }
  return existing;
}
