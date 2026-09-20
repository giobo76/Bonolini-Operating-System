import { WhatsAppCloudApiProvider } from "./whatsapp-cloud-api-provider";

// OutboundProvider — a small, swappable adapter for actually transmitting
// a prepared communication, same shape as bos-agent/image-generator.ts's
// ImageGenerator (deliberately mirrored): executeCommunication (service.ts)
// only ever depends on this interface, never on a specific channel/vendor,
// so a real provider (WhatsApp Business API, Twilio, Resend, whatever the
// founder picks) can be added later by implementing this interface and
// changing only getConfiguredOutboundProvider below — never
// service.ts/content.ts.
//
// The default provider (NotConfiguredOutboundProvider) never calls any
// external service and never fabricates a delivery — required because,
// as of this phase, NO outbound send capability exists anywhere in this
// repository (packages/core/src/whatsapp is receive/parse-only; see its
// own README and the read-only diagnosis this Phase 3 work followed from).
// Inventing a fake "sent" result here would be exactly the false-success
// this module's whole design exists to prevent (rule 6/7 of the approved
// Phase 3 spec) — it always returns status:"not_configured" with a clear
// reason, which executeCommunication treats as a real, explicit
// execution_failed outcome, never a silent/assumed success.

export interface OutboundMessageRequest {
  channel: string;
  to: string;
  body: string;
  // Passed through so a real provider can honor it as ITS OWN dedup key
  // too (most transactional messaging APIs accept one) — belt and
  // suspenders on top of this module's own DB-level unique constraint.
  idempotencyKey: string;
  // Phase 3B Step 3 — needed by channel-specific providers that must
  // resolve per-customer context to decide HOW (or whether) to send —
  // e.g. WhatsApp's 24h customer service window, which depends on the
  // client's own real inbound message history
  // (packages/core/src/whatsapp::getLastInboundReceivedAt), not on
  // anything this generic interface itself knows. A provider that doesn't
  // need this (a future generic SMS/email provider) simply ignores them.
  tenantId: string;
  clientId: string;
}

export type OutboundSendResult =
  | { status: "sent"; providerMessageId: string }
  | { status: "not_configured"; reason: string };

export interface OutboundProvider {
  readonly name: string;
  send(request: OutboundMessageRequest): Promise<OutboundSendResult>;
}

export class NotConfiguredOutboundProvider implements OutboundProvider {
  readonly name = "not_configured";

  async send(request: OutboundMessageRequest): Promise<OutboundSendResult> {
    return {
      status: "not_configured",
      reason: `no outbound provider configured for channel '${request.channel}' — see getConfiguredOutboundProvider()`,
    };
  }
}

// Phase 3B Step 3 — real provider, still NOT_CONFIGURED unless both
// required env vars are actually set (never a partial/guessed config).
// WHATSAPP_TEMPLATE_NAME/WHATSAPP_TEMPLATE_LANGUAGE are optional on top of
// those two: their absence doesn't make the provider NOT_CONFIGURED, it
// only means an outside-the-24h-window send has no template to fall back
// to and fails explicitly at send time (WhatsAppCloudApiProvider's own
// job, not this factory's) — see whatsapp-cloud-api-provider.ts.
export function getConfiguredOutboundProvider(): OutboundProvider {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    return new NotConfiguredOutboundProvider();
  }

  const templateName = process.env.WHATSAPP_TEMPLATE_NAME;
  const templateLanguage = process.env.WHATSAPP_TEMPLATE_LANGUAGE;
  const template = templateName && templateLanguage ? { name: templateName, language: templateLanguage } : null;

  return new WhatsAppCloudApiProvider(accessToken, phoneNumberId, template);
}
