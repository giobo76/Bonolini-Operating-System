import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@bos/auth";
import { assertValidOAuthRedirectUri, captureException, log, upsertConnection } from "@bos/core";

interface GoogleTokenResponse {
  refresh_token?: string;
  access_token: string;
  scope: string;
  expires_in: number;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const oauthError = searchParams.get("error");
  const storedState = request.cookies.get("marketing_oauth_state")?.value;

  const fail = (reason: string) => {
    log("marketing.oauth.callback.failed", { reason });
    const response = NextResponse.redirect(
      new URL(`/marketing/connections?error=${encodeURIComponent(reason)}`, request.url),
    );
    response.cookies.delete("marketing_oauth_state");
    return response;
  };

  if (oauthError) return fail(oauthError);
  if (!code || !state || !storedState || state !== storedState) {
    return fail("invalid_oauth_state");
  }

  const session = await getSession();
  if (!session || session.profile.role !== "admin") {
    return fail("not_authorized");
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
        client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
        redirect_uri: assertValidOAuthRedirectUri(process.env.GOOGLE_OAUTH_REDIRECT_URI),
        grant_type: "authorization_code",
      }),
    });
  } catch (error) {
    captureException(error, "marketing.oauth.callback.token_exchange_error", {
      tenantId: session.profile.tenantId,
    });
    return fail("token_exchange_failed");
  }

  if (!tokenResponse.ok) {
    captureException(new Error(`Token exchange returned ${tokenResponse.status}`), "marketing.oauth.callback.token_exchange_failed", {
      tenantId: session.profile.tenantId,
      status: tokenResponse.status,
    });
    return fail("token_exchange_failed");
  }

  const tokens = (await tokenResponse.json()) as GoogleTokenResponse;

  if (!tokens.refresh_token) {
    // Google only issues a refresh_token when consent is actually granted
    // fresh (prompt=consent above should guarantee this) — fail loudly
    // rather than silently storing a connection that can't be refreshed.
    return fail("no_refresh_token_returned");
  }

  await upsertConnection(session.profile.tenantId, {
    refreshToken: tokens.refresh_token,
    scopes: tokens.scope.split(" "),
    connectedBy: session.profile.id,
  });

  log("marketing.oauth.callback.connected", { tenantId: session.profile.tenantId });

  const response = NextResponse.redirect(
    new URL("/marketing/connections?connected=1", request.url),
  );
  response.cookies.delete("marketing_oauth_state");
  return response;
}
