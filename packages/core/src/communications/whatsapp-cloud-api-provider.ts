import { getLastInboundReceivedAt } from "../whatsapp";
import { toValidDate } from "../dates";
import { postWhatsappCloudApiMessage } from "./whatsapp-cloud-api-client";
import type { OutboundMessageRequest, OutboundProvider, OutboundSendResult } from "./provider";

// The real Meta WhatsApp Cloud API provider — same Graph API family, same
// GRAPH_API_VERSION, as packages/core/src/social-publishing/meta-client.ts's
// already-working Facebook/Instagram client (reused, not duplicated). One
// deliberate deviation from that file's own auth style: WhatsApp Cloud
// API's /messages endpoint is documented to require the access token as an
// `Authorization: Bearer <token>` HEADER, not an `access_token` body field
// (unlike the Page feed/Instagram content-publishing endpoints
// meta-client.ts calls) — verified against Meta's own WhatsApp Cloud API
// docs, not assumed from the Facebook-endpoint convention.
//
// Never fabricates a delivery: send() either returns a real Meta-issued
// providerMessageId (messages[0].id) or throws — there is no third
// "assume it worked" outcome. A thrown error is caught by
// communications/service.ts's executeCommunication and recorded as a real
// execution_failed, never silently swallowed.

export interface WhatsAppTemplateConfig {
  name: string;
  language: string;
}

// Meta's own 24h customer service window — verified against Meta's
// WhatsApp Cloud API "Customer Service Window" documentation, not assumed.
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

// E.164: a leading '+', 1-15 digits total, first digit 1-9 — the exact
// format WhatsApp Cloud API's `to` field requires (Meta's own recipient
// format, minus the leading '+' — stripped below, never guessed at).
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

export function isE164(phone: string): boolean {
  return E164_PATTERN.test(phone);
}

export class WhatsAppCloudApiProvider implements OutboundProvider {
  readonly name = "whatsapp_cloud_api";

  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
    // null when WHATSAPP_TEMPLATE_NAME/WHATSAPP_TEMPLATE_LANGUAGE aren't
    // both configured — see provider.ts's getConfiguredOutboundProvider.
    // Deliberately never invented: no template exists to guess at (see
    // this module's README "Template" section).
    private readonly template: WhatsAppTemplateConfig | null,
  ) {}

  async send(request: OutboundMessageRequest): Promise<OutboundSendResult> {
    if (!isE164(request.to)) {
      throw new Error(
        `WhatsAppCloudApiProvider: recipient '${request.to}' is not a valid E.164 phone number — refusing to send, never auto-correcting`,
      );
    }

    // Deterministic, real-data window check — never the outbound
    // message's own timestamp (rule of the approved spec: the window
    // depends on the client's last INBOUND message, not on anything
    // about this send attempt itself).
    // toValidDate: robust even if the lookup ever hands back Postgres'
    // raw timestamp text instead of a Date (the 2026-09-24 production bug).
    const lastInboundAt = toValidDate(await getLastInboundReceivedAt(request.tenantId, request.clientId));
    const windowOpen = lastInboundAt !== null && Date.now() - lastInboundAt.getTime() < SESSION_WINDOW_MS;

    const payload = windowOpen
      ? this.buildFreeFormPayload(request.to, request.body)
      : this.template
        ? this.buildTemplatePayload(request.to, this.template)
        : null;

    if (!payload) {
      throw new Error(
        "WhatsAppCloudApiProvider: the 24h customer service window is closed for this recipient and no WhatsApp template is configured (WHATSAPP_TEMPLATE_NAME/WHATSAPP_TEMPLATE_LANGUAGE) — refusing to send free-form outside the window and refusing to guess a template",
      );
    }

    const providerMessageId = await postWhatsappCloudApiMessage(this.accessToken, this.phoneNumberId, payload, {
      label: "WhatsAppCloudApiProvider",
      logName: this.name,
    });
    return { status: "sent", providerMessageId };
  }

  private buildFreeFormPayload(to: string, body: string) {
    return {
      messaging_product: "whatsapp",
      to: stripLeadingPlus(to),
      type: "text",
      text: { body },
    };
  }

  private buildTemplatePayload(to: string, template: WhatsAppTemplateConfig) {
    // No dynamic {{parameters}} — no approved template exists yet to know
    // a real placeholder structure for (see this module's README). A
    // fully static, no-variable template is a legitimate, common real
    // configuration; per-template parameter mapping is a deliberate
    // follow-up once a real template is approved, not guessed here.
    return {
      messaging_product: "whatsapp",
      to: stripLeadingPlus(to),
      type: "template",
      template: { name: template.name, language: { code: template.language } },
    };
  }
}

// WhatsApp Cloud API's `to` field convention: E.164 digits, no leading
// '+' — same digits-only convention packages/core/src/whatsapp/service.ts's
// normalizePhone already applies to INBOUND numbers, applied here to the
// already-E.164-validated recipient for the outbound call.
function stripLeadingPlus(e164: string): string {
  return e164.replace(/^\+/, "");
}
