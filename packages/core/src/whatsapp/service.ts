import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb, clients, whatsappMessages, tenants, assertOne, type Client } from "@bos/db";
import { parseWhatsappMessage } from "./parser";
import type { ExtractedWhatsappMessage, ParsedWhatsappMessage } from "./schema";

// Same pattern as clients/service.ts's getDefaultTenantId — BOS is
// single-tenant in practice today (see ADR 0004), and the WhatsApp webhook
// has no session to read a tenantId from either.
async function getDefaultTenantId(): Promise<string> {
  const db = getDb();
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, "bonolini-transfer"));
  if (!tenant) {
    throw new Error('Default tenant "bonolini-transfer" not found — was 0000_init.sql applied?');
  }
  return tenant.id;
}

// WhatsApp sends `from`/`wa_id` as digits only, no leading "+", no spaces
// (e.g. "393281234567"). clients.phone carries no such guarantee — it's
// hand-entered via the web lead form (leadSubmissionSchema only requires
// length >= 3). Normalizing both sides to digits-only before comparing is
// the only reliable way a WhatsApp number matches an existing client.
// Exported for direct testing.
export function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

// clients.phone is not unique (called out explicitly in the approved
// design) — if more than one client matches the same normalized phone, the
// most recently created one is used. Not a spec'd rule, a judgment call;
// see README.md's "decisions worth revisiting." Used both as the read-back
// after a winning/losing insert below, and directly whenever a matching
// client is expected to already exist.
async function findClientByPhone(tenantId: string, normalizedPhone: string): Promise<Client | null> {
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

// PRE-COMMIT FIX (race condition — see 0009_clients_phone_unique_per_tenant.sql):
// the previous version of this function did a plain SELECT (findClientByPhone)
// followed by a plain INSERT — a check-then-act race. Two inbound messages
// with *different* whatsapp_message_id (so both pass the message-idempotency
// guard) but the *same* phone, handled by two concurrent serverless
// invocations, could each find no existing client and each insert one,
// producing two clients rows for the same person.
//
// Fixed by making the insert itself the atomicity boundary, exactly like
// whatsapp_messages' idempotency below: INSERT ... ON CONFLICT DO NOTHING
// against the partial, tenant-scoped, functional unique index on
// (tenant_id, regexp_replace(phone, '[^0-9]','','g')) WHERE deleted_at IS
// NULL. Under real concurrency, Postgres guarantees only one such INSERT
// wins; the other observes zero returned rows and reads back the winner —
// never a second row. Raw SQL (db.execute) is used here, not Drizzle's
// query-builder .onConflictDoNothing(), because Drizzle's conflict target
// only accepts plain columns, not the expression + partial-WHERE target
// this index requires.
async function findOrCreateClientByPhone(
  tenantId: string,
  normalizedPhone: string,
  profileName: string | null,
  receivedAt: Date,
): Promise<Client> {
  const db = getDb();

  const insertedRows = await db.execute<Client>(sql`
    insert into clients (tenant_id, customer_type, full_name, phone, marketing_consent, first_touch_at)
    values (
      ${tenantId},
      'private',
      ${profileName ?? normalizedPhone},
      ${normalizedPhone},
      false,
      ${receivedAt.toISOString()}
    )
    on conflict (tenant_id, (regexp_replace(phone, '[^0-9]', '', 'g'))) where deleted_at is null
    do nothing
    returning *
  `);

  if (insertedRows.length > 0) {
    return insertedRows[0] as Client;
  }

  // Conflict: another row (created just now by a concurrent invocation, or
  // pre-existing) already holds this (tenant, normalized phone). Read it
  // back — same tie-break semantics as findClientByPhone's "most recent."
  const existing = await findClientByPhone(tenantId, normalizedPhone);
  if (!existing) {
    // Unreachable in practice: a conflict on this index means a matching
    // non-deleted client row exists. Guarded rather than silently
    // swallowed, so a genuine anomaly here fails loudly instead of
    // producing a client-less message.
    throw new Error("findOrCreateClientByPhone: insert conflicted but no matching client was found");
  }
  return existing;
}

// Only fills fields that are currently empty on the client — never
// overwrites existing data (explicit constraint). fullName is deliberately
// never touched by this path once a client row exists, even if it was
// auto-set to the phone-number placeholder above: changing a client's
// identity based on message content is a judgment call left for a human.
async function applyParsedDataToClient(client: Client, parsed: ParsedWhatsappMessage): Promise<void> {
  const updates: { email?: string; preferredLanguage?: string } = {};

  if (!client.email && parsed.email) updates.email = parsed.email;
  if (!client.preferredLanguage && parsed.language) updates.preferredLanguage = parsed.language;

  if (Object.keys(updates).length === 0) return;

  const db = getDb();
  await db
    .update(clients)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(clients.id, client.id));
}

export interface ProcessInboundMessageResult {
  status: "processed" | "duplicate";
  messageId: string;
  clientId: string | null;
  parsed: ParsedWhatsappMessage | null;
}

// The single entry point webhook-handler.ts calls per inbound message.
// Order matters: idempotency is checked (at the DB level, via the composite
// (tenant_id, whatsapp_message_id) unique index — never an in-memory Set,
// which would not survive separate serverless invocations) BEFORE any
// client lookup/create or Claude call, so a duplicate delivery never
// creates a second client and never spends an extra Claude call.
export async function processInboundMessage(
  message: ExtractedWhatsappMessage,
): Promise<ProcessInboundMessageResult> {
  const db = getDb();
  const tenantId = await getDefaultTenantId();
  const normalizedPhone = normalizePhone(message.fromPhone);

  const inserted = await db
    .insert(whatsappMessages)
    .values({
      tenantId,
      whatsappMessageId: message.waMessageId,
      fromPhone: message.fromPhone,
      rawText: message.rawText ?? `[messaggio di tipo "${message.type}" non supportato in questa fase]`,
      receivedAt: message.receivedAt,
    })
    // Composite target matching the (tenant_id, whatsapp_message_id) unique
    // index (0008) — a message id is only guaranteed unique within the
    // WhatsApp Business Account it came from, not globally.
    .onConflictDoNothing({ target: [whatsappMessages.tenantId, whatsappMessages.whatsappMessageId] })
    .returning();

  if (inserted.length === 0) {
    // Scoped by tenantId too, not just whatsappMessageId — otherwise two
    // different tenants happening to share a message id could read back
    // the wrong tenant's row here.
    const [existing] = await db
      .select()
      .from(whatsappMessages)
      .where(and(eq(whatsappMessages.tenantId, tenantId), eq(whatsappMessages.whatsappMessageId, message.waMessageId)));
    return {
      status: "duplicate",
      messageId: existing?.id ?? "",
      clientId: existing?.clientId ?? null,
      parsed: (existing?.parsed as ParsedWhatsappMessage | null) ?? null,
    };
  }

  const row = assertOne(inserted, "processInboundMessage");

  const client = await findOrCreateClientByPhone(tenantId, normalizedPhone, message.profileName, message.receivedAt);

  const parsed: ParsedWhatsappMessage =
    message.type === "text" && message.rawText ? await parseWhatsappMessage(message.rawText, message.receivedAt) : {};

  // KNOWN LIMITATION, deliberately not hidden (pre-commit review, Problema
  // 4): if findOrCreateClientByPhone or this update throw (e.g. a
  // transient DB error) after the whatsapp_messages row above was already
  // committed, that row is left permanently with client_id/parsed still
  // null — the webhook still responds 200 to Meta (see
  // webhook-handler.ts's per-message try/catch), so there is no natural
  // Meta retry to recover it, and no reaper/retry mechanism exists in
  // Phase 1. raw_text is never lost (it's written by the insert above,
  // before this point), only the client link and parsed extraction would
  // be missing. A minimal Phase 2 fix would be an Inngest cron scanning for
  // whatsapp_messages rows with client_id IS NULL older than a few minutes
  // and re-running just this tail (client link + parse + update) —
  // deliberately not built now: it's a new scheduled job + reprocessing
  // path, more than this pre-commit hardening pass should introduce
  // unilaterally.
  await db
    .update(whatsappMessages)
    .set({ clientId: client.id, parsed })
    .where(eq(whatsappMessages.id, row.id));

  await applyParsedDataToClient(client, parsed);

  return { status: "processed", messageId: row.id, clientId: client.id, parsed };
}
