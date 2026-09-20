export { socialPublishingRouter } from "./router";
export * from "./schema";
export { runWeeklySocialPost, listSocialPosts, getWeekStartDateEuropeRome, retryFacebookOnly } from "./service";
export type { RetryFacebookOnlyResult } from "./service";
export { getRealPostDataSnapshot, hasEnoughDataForPost, classifyTransferType } from "./content-source";
export type { RealPostDataSnapshot, ServedRoute, TransferTypeLabel } from "./content-source";
export { validatePost } from "./validator";
export type { PostValidationResult } from "./validator";
export { socialPublishingInngestFunctions } from "./inngest-functions";
export { GRAPH_API_VERSION } from "./meta-client";
export type { SocialPost, NewSocialPost } from "@bos/db";

// Module boundary rule (ADR 0002): other modules/apps import only from here.
// This module reads bookings' own pickup/destination columns directly
// (content-source.ts) — the same narrow, documented, read-only exception
// marketing/business-kpis.ts already takes for cross-module KPI reporting —
// but never writes to any table it doesn't own (social_posts).
