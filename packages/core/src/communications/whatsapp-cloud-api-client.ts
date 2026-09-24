import { GRAPH_API_VERSION } from "../social-publishing";
import { log, captureException } from "../observability";

// The one place that POSTs to WhatsApp Cloud API's /messages endpoint.
// Shared by WhatsAppCloudApiProvider (customer messages, which also decides
// free-form vs template from the customer's 24h window) and by
// quote-approval's founder notifications (which check the founder's own
// window). The access token goes only into the Authorization header, never
// into a log line, an error message or a return value.

interface GraphApiErrorBody {
  error?: { message?: string };
}

interface WhatsAppSendSuccessBody {
  messages?: Array<{ id?: string }>;
}

export interface WhatsappCloudApiCredentials {
  accessToken: string;
  phoneNumberId: string;
}

export function getWhatsappCloudApiCredentials(): WhatsappCloudApiCredentials | null {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) return null;
  return { accessToken, phoneNumberId };
}

// Returns Meta's message id (wamid) or throws — never an assumed success.
export async function postWhatsappCloudApiMessage(
  accessToken: string,
  phoneNumberId: string,
  payload: Record<string, unknown>,
  options: { label: string; logName: string },
): Promise<string> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    captureException(error, "communications.whatsapp_provider.network_error", {
      provider: options.logName,
      httpStatus: null,
    });
    throw new Error(`${options.label}: network error calling Graph API — ${message}`);
  }

  const body = (await response.json().catch(() => null)) as (WhatsAppSendSuccessBody & GraphApiErrorBody) | null;
  const providerMessageId = body?.messages?.[0]?.id;

  if (!response.ok || !providerMessageId) {
    const reason = body?.error?.message ?? `Graph API returned HTTP ${response.status}`;
    captureException(new Error(reason), "communications.whatsapp_provider.send_failed", {
      provider: options.logName,
      httpStatus: response.status,
    });
    throw new Error(`${options.label}: ${reason}`);
  }

  log("communications.whatsapp_provider.sent", {
    provider: options.logName,
    providerMessageId,
    httpStatus: response.status,
  });

  return providerMessageId;
}
