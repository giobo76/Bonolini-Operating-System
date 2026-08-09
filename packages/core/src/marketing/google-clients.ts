import { google } from "googleapis";
import { eq } from "drizzle-orm";
import { getDb, marketingConnections } from "@bos/db";
import { decryptToken } from "./encryption";

// UNVERIFIED AGAINST A LIVE GOOGLE ACCOUNT: this file was written against
// documented Google API shapes, not tested against a real connection — no
// Node runtime was available while building it. Expect to debug real
// issues (exact response shapes, quota errors, token edge cases) the first
// time this actually runs. See packages/core/src/marketing/README.md.

async function getOAuth2Client(tenantId: string) {
  const db = getDb();
  const [connection] = await db
    .select()
    .from(marketingConnections)
    .where(eq(marketingConnections.tenantId, tenantId));

  if (!connection || connection.status !== "active") {
    throw new Error("No active Google connection for this tenant — connect one at /marketing/connections");
  }

  const refreshToken = decryptToken(connection.encryptedRefreshToken);

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  // If Google reports the refresh token itself is invalid (revoked access,
  // expired), flag the connection so /marketing/connections can prompt a
  // reconnect instead of failing silently on every check run.
  oauth2Client.on("tokens", () => {
    // Access token refreshed successfully — no action needed, this
    // listener exists so a future invalid_grant handler has a clear place
    // to live (see the catch-and-mark-needs-reauth pattern in run-check.ts).
  });

  return oauth2Client;
}

export async function getAnalyticsDataClient(tenantId: string) {
  const auth = await getOAuth2Client(tenantId);
  return google.analyticsdata({ version: "v1beta", auth });
}

export async function getTagManagerClient(tenantId: string) {
  const auth = await getOAuth2Client(tenantId);
  return google.tagmanager({ version: "v2", auth });
}

export async function getSearchConsoleClient(tenantId: string) {
  const auth = await getOAuth2Client(tenantId);
  return google.searchconsole({ version: "v1", auth });
}

// The GTM public container ID (GTM-XXXXXXX, what's visible on the site and
// what /marketing/connections asks for) is not the same as the internal
// accounts/{accountId}/containers/{containerId} path the Tag Manager API
// actually needs. Resolve it by listing accessible accounts/containers and
// matching on publicId, so the UI doesn't have to ask for the internal path.
export async function resolveGtmContainer(tenantId: string, publicId: string) {
  const tagmanager = await getTagManagerClient(tenantId);
  const accounts = await tagmanager.accounts.list();

  for (const account of accounts.data.account ?? []) {
    if (!account.path) continue;
    const containers = await tagmanager.accounts.containers.list({ parent: account.path });
    const match = containers.data.container?.find((c) => c.publicId === publicId);
    if (match?.path && match.containerId) {
      return { tagmanager, path: match.path, containerId: match.containerId };
    }
  }

  throw new Error(
    `GTM container ${publicId} was not found in the connected Google account — check the ID at /marketing/connections`,
  );
}
