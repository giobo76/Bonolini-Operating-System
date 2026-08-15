import { NextResponse, type NextRequest } from "next/server";
import { handleLeadIntentRequest, handleLeadIntentPreflight } from "@bos/core";

// Public, unauthenticated, cross-origin — the only caller is the inline
// tracking script on bonolinitransfer.com (WordPress), never this app's own
// UI. Deliberately excluded from middleware.ts's PUBLIC_PATHS as this exact
// path only (not "/api/marketing"), and it is the only route under
// /api/marketing exempted from the Supabase session gate.
//
// All real logic (origin allowlisting, rate limiting, payload validation,
// the actual write) lives in packages/core/src/marketing/lead-intent-
// handler.ts, unit-tested there — this file only translates NextRequest/
// NextResponse to/from that framework-agnostic handler.

function corsHeaders(origin: string | null): HeadersInit {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export async function OPTIONS(request: NextRequest) {
  const result = handleLeadIntentPreflight(request.headers.get("origin"));
  return new NextResponse(null, { status: result.status, headers: corsHeaders(result.corsOrigin) });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const rawBody = await request.text();
  // Vercel and most reverse proxies set x-forwarded-for; falls back to a
  // shared bucket if absent rather than throwing — loses per-IP
  // granularity for that one request, doesn't break the endpoint.
  const rateLimitKey = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  const result = await handleLeadIntentRequest({ origin, rawBody, rateLimitKey });

  return NextResponse.json(result.body, { status: result.status, headers: corsHeaders(result.corsOrigin) });
}
