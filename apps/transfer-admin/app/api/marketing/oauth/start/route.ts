import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@bos/auth";
import { log } from "@bos/core";

// Read-only scopes only. tagmanager.edit.containers (needed for the future
// GTM auto-fix capability) is deliberately not requested here — least
// privilege: request it when the capability that uses it actually exists.
// Google Ads' own scope isn't truly read-only at the OAuth layer — see
// packages/core/src/marketing/README.md.
const SCOPES = [
  "https://www.googleapis.com/auth/adwords",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/tagmanager.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
];

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session || session.profile.role !== "admin") {
    log("marketing.oauth.start.rejected", { tenantId: session?.profile.tenantId ?? null });
    return NextResponse.redirect(new URL("/marketing/connections", request.url));
  }

  log("marketing.oauth.start", { tenantId: session.profile.tenantId });
  const state = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI!,
    response_type: "code",
    access_type: "offline",
    // Forces Google to return a refresh_token even on a re-connect, not
    // just on the very first-ever consent.
    prompt: "consent",
    scope: SCOPES.join(" "),
    state,
  });

  const response = NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  );

  response.cookies.set("marketing_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return response;
}
