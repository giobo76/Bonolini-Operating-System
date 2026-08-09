import { and, count, desc, eq, ilike, isNotNull, isNull, or } from "drizzle-orm";
import { getDb, clients, tenants, assertOne } from "@bos/db";
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
