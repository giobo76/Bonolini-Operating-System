import { and, desc, eq } from "drizzle-orm";
import { getDb, quotes, assertOne, type Quote } from "@bos/db";
import type { CreateQuoteInput } from "./schema";

export async function createQuote(tenantId: string, input: CreateQuoteInput) {
  const db = getDb();
  const rows = await db
    .insert(quotes)
    .values({ tenantId, ...input })
    .returning();
  return assertOne(rows, "createQuote");
}

export async function listQuotesForClient(tenantId: string, clientId: string) {
  const db = getDb();
  return db
    .select()
    .from(quotes)
    .where(and(eq(quotes.tenantId, tenantId), eq(quotes.clientId, clientId)))
    .orderBy(desc(quotes.createdAt));
}

export async function getQuote(tenantId: string, id: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(quotes)
    .where(and(eq(quotes.tenantId, tenantId), eq(quotes.id, id)));
  return row ?? null;
}

export async function updateQuoteStatus(tenantId: string, id: string, status: Quote["status"]) {
  const db = getDb();
  const [row] = await db
    .update(quotes)
    .set({
      status,
      respondedAt: status === "accepted" || status === "declined" ? new Date() : undefined,
      updatedAt: new Date(),
    })
    .where(and(eq(quotes.tenantId, tenantId), eq(quotes.id, id)))
    .returning();
  return row ?? null;
}
