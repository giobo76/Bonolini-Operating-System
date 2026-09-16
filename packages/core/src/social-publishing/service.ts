import { and, desc, eq } from "drizzle-orm";
import { getDb, socialPosts, assertOne, type SocialPost } from "@bos/db";
import { getRealPostDataSnapshot, hasEnoughDataForPost, type RealPostDataSnapshot } from "./content-source";
import { generatePostContent } from "./content-generator";
import { validatePost, validateInstagramCaptionLength } from "./validator";
import { publishTextPost, publishInstagramPost } from "./meta-client";
import { captureException, log } from "../observability";

// ── Instagram, alongside Facebook ────────────────────────────────────────
// Instagram publishes the exact same generated/validated content as
// Facebook (never a second Claude call, never separately validated for
// CTA/forbidden-content/language — validatePost() already gated that above;
// only the caption-length limit differs per platform, see validator.ts) as
// an image post — Instagram has no text-only feed post type, so an image is
// mandatory. Deliberately independent of Facebook's own outcome in both
// directions: a Facebook Graph API failure must never block Instagram, and
// vice versa, per the founder's explicit requirement to keep Facebook
// working while adding Instagram. "skipped" (not "failed") is used when
// Instagram simply isn't configured yet — mirrors FACEBOOK_PAGE_ID/
// FACEBOOK_PAGE_ACCESS_TOKEN's own "not yet configured, not an error" state
// (see README.md).
interface InstagramOutcome {
  instagramStatus: SocialPost["instagramStatus"];
  instagramMediaId: string | null;
  instagramError: string | null;
  instagramPublishedAt: Date | null;
}

async function publishToInstagram(content: string, tenantId: string, weekStartDate: string): Promise<InstagramOutcome> {
  const imageUrl = process.env.INSTAGRAM_POST_IMAGE_URL;
  const igUserId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;

  if (!igUserId || !imageUrl) {
    log("social_publishing.weekly_post.instagram_skipped_not_configured", { tenantId, weekStartDate });
    return { instagramStatus: "skipped", instagramMediaId: null, instagramError: null, instagramPublishedAt: null };
  }

  const captionError = validateInstagramCaptionLength(content);
  if (captionError) {
    captureException(new Error(captionError), "social_publishing.weekly_post.instagram_validation_failed", {
      tenantId,
      weekStartDate,
    });
    return { instagramStatus: "failed", instagramMediaId: null, instagramError: captionError, instagramPublishedAt: null };
  }

  const result = await publishInstagramPost(content, imageUrl);

  if (!result.ok) {
    captureException(new Error(result.error ?? "Instagram Graph API publish failed"), "social_publishing.weekly_post.instagram_publish_failed", {
      tenantId,
      weekStartDate,
    });
    return {
      instagramStatus: "failed",
      instagramMediaId: null,
      instagramError: result.error ?? "unknown Graph API error",
      instagramPublishedAt: null,
    };
  }

  log("social_publishing.weekly_post.instagram_published", { tenantId, weekStartDate, instagramMediaId: result.mediaId });
  return {
    instagramStatus: "published",
    instagramMediaId: result.mediaId ?? null,
    instagramError: null,
    instagramPublishedAt: new Date(),
  };
}

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

  // Defaults instagramStatus to "failed" with the same reason too: every
  // call site below this point is a shared upstream failure (no real data,
  // no generated content, failed validation, or an unexpected exception) —
  // neither platform ever had a post to publish that week. The one branch
  // where Facebook and Instagram genuinely diverge (each platform's own
  // Graph API call) sets instagramStatus itself via publishToInstagram's
  // own result, passed through `extra`.
  async function markFailed(metaError: string, extra: Partial<SocialPost> = {}): Promise<SocialPost> {
    const update = { status: "failed" as const, metaError, instagramStatus: "failed" as const, instagramError: metaError, updatedAt: new Date(), ...extra };
    await db.update(socialPosts).set(update).where(eq(socialPosts.id, row.id));
    return { ...row, ...update };
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

    // Facebook and Instagram are each other's independent concern from here
    // on — a Graph API failure on one platform is recorded and never
    // prevents attempting, or reports on, the other (see publishToInstagram's
    // own header comment). Sequential, not parallel, only so the log lines
    // for each stay easy to read in order; there is no dependency between
    // the two calls.
    const publishResult = await publishTextPost(content);

    if (!publishResult.ok) {
      captureException(new Error(publishResult.error ?? "Graph API publish failed"), "social_publishing.weekly_post.publish_failed", {
        tenantId,
        weekStartDate,
      });
    } else {
      log("social_publishing.weekly_post.published", { tenantId, weekStartDate, metaPostId: publishResult.postId });
    }

    const instagram = await publishToInstagram(content, tenantId, weekStartDate);

    const update: Partial<SocialPost> = {
      status: publishResult.ok ? "published" : "failed",
      metaPostId: publishResult.ok ? (publishResult.postId ?? null) : null,
      metaError: publishResult.ok ? null : (publishResult.error ?? "unknown Graph API error"),
      publishedAt: publishResult.ok ? new Date() : null,
      instagramStatus: instagram.instagramStatus,
      instagramMediaId: instagram.instagramMediaId,
      instagramError: instagram.instagramError,
      instagramPublishedAt: instagram.instagramPublishedAt,
      updatedAt: new Date(),
    };

    await db.update(socialPosts).set(update).where(eq(socialPosts.id, row.id));

    return {
      ...row,
      content,
      dataSnapshot: snapshot as unknown as SocialPost["dataSnapshot"],
      ...update,
    } as SocialPost;
  } catch (error) {
    captureException(error, "social_publishing.weekly_post.unexpected_error", { tenantId, weekStartDate });
    await markFailed(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export interface RetryFacebookOnlyResult {
  ok: boolean;
  alreadyPublished: boolean;
  facebookPostId: string | null;
  error: string | null;
  post: SocialPost;
}

// ── Facebook-only retry ──────────────────────────────────────────────────
// Lets an admin retry just the Facebook half of one specific, already-
// existing social_posts row (typically one whose Facebook publish
// previously failed) without touching Instagram in any way and without
// re-running the full weekly pipeline (runWeeklySocialPost) — no new data
// snapshot, no second Claude call, no re-validation: it reuses row.content
// exactly as already saved. Idempotent the same way the rest of this module
// is: if Facebook already succeeded (status 'published' with a metaPostId
// already set), this is a pure read, never a second Graph API call and
// never a duplicate Facebook post. The update this writes touches only the
// columns socialPosts' own schema comment already documents as "the
// Facebook pipeline" (status/metaPostId/metaError/publishedAt) — the
// instagram* columns are never read from or written to here.
export async function retryFacebookOnly(tenantId: string, postId: string): Promise<RetryFacebookOnlyResult | null> {
  const db = getDb();

  const rows = await db
    .select()
    .from(socialPosts)
    .where(and(eq(socialPosts.id, postId), eq(socialPosts.tenantId, tenantId)));
  const row = rows[0];
  if (!row) return null;

  if (row.status === "published" && row.metaPostId) {
    log("social_publishing.retry_facebook_only.already_published", { tenantId, postId, metaPostId: row.metaPostId });
    return { ok: true, alreadyPublished: true, facebookPostId: row.metaPostId, error: null, post: row };
  }

  if (!row.content) {
    return {
      ok: false,
      alreadyPublished: false,
      facebookPostId: null,
      error: "no content saved on this post to retry",
      post: row,
    };
  }

  const publishResult = await publishTextPost(row.content);

  const update = publishResult.ok
    ? {
        status: "published" as const,
        metaPostId: publishResult.postId ?? null,
        metaError: null,
        publishedAt: new Date(),
        updatedAt: new Date(),
      }
    : {
        status: "failed" as const,
        metaError: publishResult.error ?? "unknown Graph API error",
        updatedAt: new Date(),
      };

  await db.update(socialPosts).set(update).where(eq(socialPosts.id, row.id));

  if (!publishResult.ok) {
    captureException(
      new Error(publishResult.error ?? "Graph API publish failed"),
      "social_publishing.retry_facebook_only.publish_failed",
      { tenantId, postId },
    );
  } else {
    log("social_publishing.retry_facebook_only.published", { tenantId, postId, metaPostId: publishResult.postId });
  }

  return {
    ok: publishResult.ok,
    alreadyPublished: false,
    facebookPostId: publishResult.ok ? (publishResult.postId ?? null) : null,
    error: publishResult.ok ? null : (publishResult.error ?? "unknown Graph API error"),
    post: { ...row, ...update },
  };
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
