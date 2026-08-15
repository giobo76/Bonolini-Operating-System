import { createRateLimiter } from "../rate-limit";
import { log, captureException } from "../observability";
import { recordLeadIntentSchema } from "./schema";
import { recordLeadIntent } from "./service";

// The transport-framework-agnostic core of POST /api/marketing/lead-intent
// (apps/transfer-admin/app/api/marketing/lead-intent/route.ts). Kept here,
// not in the route handler, so it can be unit tested with the same
// vitest + mocked @bos/db pattern already used throughout this module
// (transfer-admin has no test setup at all — see package.json) rather than
// inventing a new one, and so route.ts stays a thin Next.js adapter.
//
// This is the first genuinely public, cross-origin, unauthenticated HTTP
// entry point in the codebase — unlike clients.submitLead (public, but only
// ever reached in-process from transfer-web's own server action) or
// /api/inngest (public, but callers authenticate via request signing, not
// CORS). Origin allowlisting here is enforced server-side, not just via
// response headers — a non-browser caller ignoring CORS entirely must still
// be rejected.

export const ALLOWED_ORIGIN = "https://bonolinitransfer.com";

// 8 KiB is generous for this payload shape (the largest possible valid body,
// every optional field at its max length, is well under 4 KiB) — this is a
// cheap guard against wasting CPU on JSON.parse/zod for an oversized body,
// not a real memory-safety boundary (the body is already fully buffered by
// the time route.ts calls request.text(); a true limit needs to live at the
// platform/proxy layer).
const MAX_BODY_BYTES = 8 * 1024;

// KNOWN LIMITATION, deliberately not hidden: createRateLimiter is in-memory
// (a plain Map, see packages/core/src/rate-limit.ts), scoped to a single
// running process. docs/ARCHITECTURE.md documents Vercel as the intended
// deploy target, which runs serverless/multi-instance — under that
// deployment this limiter would NOT coordinate across instances, so it is
// best-effort defense-in-depth only, not an authoritative rate limit. No
// Redis/Upstash/KV infrastructure exists anywhere in this project today
// (checked: no such env vars, no such dependency) — introducing one is a
// real infrastructure decision, not something to add silently inside this
// handler. This is the exact same limitation clients.submitLead already
// has (submitLeadRateLimiter, apps/transfer-web/app/request-quote/
// rate-limit.ts) — not a new gap, but worth restating here since this
// endpoint is reachable from the public internet with no auth at all.
const rateLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

export interface LeadIntentRequestInput {
  origin: string | null;
  rawBody: string;
  rateLimitKey: string;
}

export interface LeadIntentResult {
  status: number;
  body: { ok: boolean; error?: string };
  // Access-Control-Allow-Origin value to send, or null to send no CORS
  // header at all (disallowed-origin responses must not have one).
  corsOrigin: string | null;
}

export function handleLeadIntentPreflight(origin: string | null): LeadIntentResult {
  if (origin !== ALLOWED_ORIGIN) {
    return { status: 204, body: { ok: false }, corsOrigin: null };
  }
  return { status: 204, body: { ok: true }, corsOrigin: ALLOWED_ORIGIN };
}

export async function handleLeadIntentRequest(input: LeadIntentRequestInput): Promise<LeadIntentResult> {
  if (input.origin !== ALLOWED_ORIGIN) {
    log("marketing.lead_intent.rejected", { reason: "origin_not_allowed" });
    return { status: 403, body: { ok: false, error: "forbidden" }, corsOrigin: null };
  }

  const rate = rateLimiter(input.rateLimitKey);
  if (!rate.ok) {
    log("marketing.lead_intent.rejected", { reason: "rate_limited" });
    return { status: 429, body: { ok: false, error: "rate_limited" }, corsOrigin: ALLOWED_ORIGIN };
  }

  if (input.rawBody.length > MAX_BODY_BYTES) {
    log("marketing.lead_intent.rejected", { reason: "payload_too_large" });
    return { status: 400, body: { ok: false, error: "invalid_payload" }, corsOrigin: ALLOWED_ORIGIN };
  }

  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    log("marketing.lead_intent.rejected", { reason: "invalid_json" });
    return { status: 400, body: { ok: false, error: "invalid_payload" }, corsOrigin: ALLOWED_ORIGIN };
  }

  const parsed = recordLeadIntentSchema.safeParse(json);
  if (!parsed.success) {
    log("marketing.lead_intent.rejected", { reason: "invalid_payload" });
    return { status: 400, body: { ok: false, error: "invalid_payload" }, corsOrigin: ALLOWED_ORIGIN };
  }

  try {
    // Log only the channel — never landingPage/referrer/utm*/gclid/
    // visitorId, per the explicit instruction not to log attribution
    // values even at "diagnostic" granularity.
    await recordLeadIntent(parsed.data);
    log("marketing.lead_intent.recorded", { channel: parsed.data.channel });
    return { status: 201, body: { ok: true }, corsOrigin: ALLOWED_ORIGIN };
  } catch (error) {
    captureException(error, "marketing.lead_intent.failed", { channel: parsed.data.channel });
    return { status: 500, body: { ok: false, error: "internal_error" }, corsOrigin: ALLOWED_ORIGIN };
  }
}
