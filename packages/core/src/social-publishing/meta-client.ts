// Publishing only — generation lives in content-generator.ts, validation in
// validator.ts, per the founder's explicit instruction to keep these
// concerns separate. This module never reads a data snapshot and never
// decides whether a post is acceptable; it only ever sends whatever text
// string it's given to the one endpoint that creates a Page feed post.
//
// Graph API version verified directly against Meta's official changelog
// (developers.facebook.com/docs/graph-api/changelog and
// .../guides/versioning) on 2026-09-05: v26.0 is the current released
// version (July 29, 2026); each version stays available for at least two
// years from release, and v23.0 and earlier have already reached end of
// life. v26.0's own changes (blocked commerce endpoints, ad-placement
// changes) do not affect POST /{page-id}/feed. Update this constant (not a
// scattered literal elsewhere) the next time this is verified against
// Meta's docs — do not bump it reflexively without checking.
const GRAPH_API_VERSION = "v26.0";

export interface PublishPostResult {
  ok: boolean;
  postId?: string;
  error?: string;
}

interface GraphApiErrorBody {
  error?: { message?: string };
}

interface GraphApiSuccessBody {
  id?: string;
}

// Never logs FACEBOOK_PAGE_ACCESS_TOKEN, under any outcome — it's read once
// from the environment and only ever placed in the outgoing request body,
// never in a returned value, a thrown error's message, or anything passed
// to log()/captureException() by this function or its caller (service.ts).
export async function publishTextPost(message: string): Promise<PublishPostResult> {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

  if (!pageId || !accessToken) {
    return { ok: false, error: "FACEBOOK_PAGE_ID or FACEBOOK_PAGE_ACCESS_TOKEN is not set" };
  }

  try {
    const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, access_token: accessToken }),
    });

    const body = (await response.json().catch(() => null)) as (GraphApiSuccessBody & GraphApiErrorBody) | null;

    if (!response.ok || !body?.id) {
      return {
        ok: false,
        error: body?.error?.message ?? `Graph API returned HTTP ${response.status}`,
      };
    }

    return { ok: true, postId: body.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface PublishInstagramPostResult {
  ok: boolean;
  mediaId?: string;
  error?: string;
}

// Instagram Content Publishing (developers.facebook.com/docs/instagram-platform/
// instagram-graph-api/content-publishing), verified against Meta's docs
// alongside GRAPH_API_VERSION above on the same date: a two-step flow against
// the Instagram Business Account (create a media container, then publish it)
// — there is no single-call equivalent of publishTextPost's feed endpoint,
// and an image is mandatory (Instagram has no text-only feed post type, unlike
// a Facebook Page). Authenticated with FACEBOOK_PAGE_ACCESS_TOKEN, not a
// separate Instagram token: once instagram_basic + instagram_content_publish
// are granted on the same Meta App/Page (see README's Instagram section),
// Meta authenticates Instagram Graph API calls with the linked Page's own
// Page Access Token — no second secret exists to configure.
export async function publishInstagramPost(caption: string, imageUrl: string): Promise<PublishInstagramPostResult> {
  const igUserId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

  if (!igUserId || !accessToken) {
    return { ok: false, error: "INSTAGRAM_BUSINESS_ACCOUNT_ID or FACEBOOK_PAGE_ACCESS_TOKEN is not set" };
  }

  try {
    const containerResponse = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${igUserId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: imageUrl, caption, access_token: accessToken }),
    });
    const containerBody = (await containerResponse.json().catch(() => null)) as
      | (GraphApiSuccessBody & GraphApiErrorBody)
      | null;

    if (!containerResponse.ok || !containerBody?.id) {
      return {
        ok: false,
        error:
          containerBody?.error?.message ??
          `Graph API returned HTTP ${containerResponse.status} while creating the media container`,
      };
    }

    // The container id (creation_id) is single-use and short-lived — publish
    // it immediately, never store or reuse it across requests.
    const publishResponse = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${igUserId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: containerBody.id, access_token: accessToken }),
    });
    const publishBody = (await publishResponse.json().catch(() => null)) as
      | (GraphApiSuccessBody & GraphApiErrorBody)
      | null;

    if (!publishResponse.ok || !publishBody?.id) {
      return {
        ok: false,
        error:
          publishBody?.error?.message ??
          `Graph API returned HTTP ${publishResponse.status} while publishing the media container`,
      };
    }

    return { ok: true, mediaId: publishBody.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
