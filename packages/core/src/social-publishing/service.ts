import { and, desc, eq } from "drizzle-orm";
import { getDb, socialPosts, assertOne, type SocialPost } from "@bos/db";
import { getRealPostDataSnapshot, hasEnoughDataForPost, type RealPostDataSnapshot } from "./content-source";
import { generatePostContent } from "./content-generator";
import { validatePost } from "./validator";
import { publishTextPost } from "./meta-client";
import { captureException, log } from "../observability";

// ── Idempotency ───────────────────────────────────────────────────────────
// The real boundary is the DB: UNIQUE(tenant_id, week_start_date) on
// social_posts (see packages/db/src/schema/social-publishing.ts), enforced
// here via INSERT ... ON CONFLICT DO NOTHING — never an application-level
// check-then-act, which would race exactly like the pre-fix WhatsApp
// find-or-create bug did (see whatsapp/service.ts's own history comment).

// Monday of the ISO week containing `date`, evaluated in Europe/Rome — the
// cron always fires Monday 09:00 Europe/Rome (see inngest-functions.ts), but
// this is computed generally from the trigger instant, not from "today," so
// a delayed retry still resolves to the same intended week.
export function getWeekStartDateEuropeRome(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const weekday = weekdayMap[get("weekday")] ?? 1;

  // Built as a UTC-anchored calendar calculator (midday, to avoid a DST-edge
  // rollover when subtracting days) — never reinterpreted as an instant in
  // another timezone, only used to compute a calendar date arithmetic
  // result.
  const asUtcNoon = new Date(Date.UTC(year, month - 1, day, 12));
  const monday = new Date(asUtcNoon.getTime() - (weekday - 1) * 24 * 60 * 60 * 1000);
  return monday.toISOString().slice(0, 10);
}

interface EnsureWeeklyPostRowResult {
  row: SocialPost;
  created: boolean;
}

async function ensureWeeklyPostRow(tenantId: string, weekStartDate: string): Promise<EnsureWeeklyPostRowResult> {
  const db = getDb();

  const inserted = await db
    .insert(socialPosts)
    .values({ tenantId, weekStartDate })
    .onConflictDoNothing({ target: [socialPosts.tenantId, socialPosts.weekStartDate] })
    .returning();

  if (inserted.length > 0) {
    return { row: assertOne(inserted, "ensureWeeklyPostRow: insert"), created: true };
  }

  const existing = await db
    .select()
    .from(socialPosts)
    .where(and(eq(socialPosts.tenantId, tenantId), eq(socialPosts.weekStartDate, weekStartDate)));
  return { row: assertOne(existing, "ensureWeeklyPostRow: existing row must exist after a conflicting insert"), created: false };
}

// ── Orchestration ─────────────────────────────────────────────────────────
// Deliberately sequential, not parallelized: generation depends on the data
// snapshot, validation depends on the generated content, and publishing
// depends on validation having passed — each step's own module
// (content-source / content-generator / validator / meta-client) owns
// exactly one concern, this function only sequences them and persists the
// outcome after each one.

export async function runWeeklySocialPost(tenantId: string, referenceDate: Date = new Date()): Promise<SocialPost> {
  const weekStartDate = getWeekStartDateEuropeRome(referenceDate);
  const { row, created } = await ensureWeeklyPostRow(tenantId, weekStartDate);

  if (!created && row.status !== "draft") {
    // Already handled (published, or a previously recorded failure) this
    // week — the real idempotency check. A 'draft' row is only ever the
    // brief window between the insert above and this same function
    // finishing its own run; it is never re-created by a second insert
    // (ON CONFLICT DO NOTHING), so falling through below on 'draft' can at
    // worst mean two near-simultaneous invocations both attempt to process
    // it — Meta's own idempotency is out of scope for this pass (see
    // README.md).
    log("social_publishing.weekly_post.skipped_already_handled", { tenantId, weekStartDate, status: row.status });
    return row;
  }

  const db = getDb();

  async function markFailed(metaError: string, extra: Partial<SocialPost> = {}): Promise<SocialPost> {
    await db
      .update(socialPosts)
      .set({ status: "failed", metaError, updatedAt: new Date(), ...extra })
      .where(eq(socialPosts.id, row.id));
    return { ...row, status: "failed", metaError, ...extra };
  }

  try {
    const snapshot: RealPostDataSnapshot = await getRealPostDataSnapshot(tenantId);

    if (!hasEnoughDataForPost(snapshot)) {
      log("social_publishing.weekly_post.no_data", { tenantId, weekStartDate });
      return await markFailed("not enough real data to generate a post this week", { dataSnapshot: snapshot });
    }

    const content = await generatePostContent(snapshot);
    if (!content) {
      log("social_publishing.weekly_post.generation_unavailable", { tenantId, weekStartDate });
      return await markFailed("content generation unavailable (ANTHROPIC_API_KEY not set, or no text returned)", {
        dataSnapshot: snapshot,
      });
    }

    const validation = validatePost(content, snapshot);
    if (!validation.valid) {
      captureException(new Error("generated social post failed validation"), "social_publishing.weekly_post.validation_failed", {
        tenantId,
        weekStartDate,
        errors: validation.errors,
      });
      return await markFailed(`validation failed: ${validation.errors.join("; ")}`, {
        content,
        dataSnapshot: snapshot,
        generatedAt: new Date(),
      });
    }

    await db
      .update(socialPosts)
      .set({ status: "validated", content, dataSnapshot: snapshot, generatedAt: new Date(), updatedAt: new Date() })
      .where(eq(socialPosts.id, row.id));

    const publishResult = await publishTextPost(content);

    if (!publishResult.ok) {
      captureException(new Error(publishResult.error ?? "Graph API publish failed"), "social_publishing.weekly_post.publish_failed", {
        tenantId,
        weekStartDate,
      });
      return await markFailed(publishResult.error ?? "unknown Graph API error");
    }

    await db
      .update(socialPosts)
      .set({ status: "published", metaPostId: publishResult.postId, publishedAt: new Date(), updatedAt: new Date() })
      .where(eq(socialPosts.id, row.id));

    log("social_publishing.weekly_post.published", { tenantId, weekStartDate, metaPostId: publishResult.postId });

    return {
      ...row,
      status: "published",
      content,
      dataSnapshot: snapshot as unknown as SocialPost["dataSnapshot"],
      metaPostId: publishResult.postId ?? null,
    };
  } catch (error) {
    captureException(error, "social_publishing.weekly_post.unexpected_error", { tenantId, weekStartDate });
    await markFailed(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function listSocialPosts(tenantId: string, limit = 20): Promise<SocialPost[]> {
  const db = getDb();
  return db
    .select()
    .from(socialPosts)
    .where(eq(socialPosts.tenantId, tenantId))
    .orderBy(desc(socialPosts.weekStartDate))
    .limit(limit);
}
