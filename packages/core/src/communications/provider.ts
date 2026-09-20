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

export function getConfiguredOutboundProvider(): OutboundProvider {
  // Provider selection is the one place this ever changes — swap this
  // return value for a real adapter once one is built, reviewed, and
  // explicitly approved by the founder (see communications/README.md's
  // "Provider" section for why none exists yet). executeCommunication
  // never needs to change.
  return new NotConfiguredOutboundProvider();
}
