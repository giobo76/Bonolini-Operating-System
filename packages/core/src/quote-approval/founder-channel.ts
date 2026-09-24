import { Resend } from "resend";
import { getWhatsappCloudApiCredentials, isE164, postWhatsappCloudApiMessage } from "../communications";
import { normalizePhone } from "../whatsapp";
import { log, captureException } from "../observability";
import { getFounderLastInboundAt } from "./repository";
import { FOUNDER_TEXTS } from "./content";

// Delivery of messages to the founder. WhatsApp free-form/interactive
// messages only reach someone who wrote to the business number in the last
// 24h (Meta's customer service window, which applies to the founder too).
// Outside it — or if the WhatsApp send fails for any other reason — the same
// content goes by email via Resend to MARKETING_ALERT_EMAIL. Buttons don't
// exist in email, so the email tells the founder how to get them back.

const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
// Meta's limit for an interactive message body.
const INTERACTIVE_BODY_MAX = 1024;

export interface FounderButton {
  id: string;
  title: string;
}

export interface FounderMessage {
  // Sent in order. When `buttons` is set they are attached to the last part.
  parts: string[];
  buttons?: FounderButton[];
  emailSubject: string;
}

export type FounderDeliveryResult =
  | { channel: "whatsapp"; error: null }
  | { channel: "email"; error: string | null }
  | { channel: "none"; error: string };

export function getFounderPhoneE164(): string | null {
  const raw = process.env.FOUNDER_WHATSAPP_PHONE;
  if (!raw) return null;
  const e164 = `+${normalizePhone(raw)}`;
  return isE164(e164) ? e164 : null;
}

export function isFounderPhone(fromPhone: string): boolean {
  const founder = getFounderPhoneE164();
  return founder !== null && normalizePhone(fromPhone) === normalizePhone(founder);
}

function textPayload(to: string, body: string) {
  return { messaging_product: "whatsapp", to: normalizePhone(to), type: "text", text: { body } };
}

function interactivePayload(to: string, body: string, buttons: FounderButton[]) {
  return {
    messaging_product: "whatsapp",
    to: normalizePhone(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
    },
  };
}

// Button messages carry one body of at most 1024 chars: parts are merged
// into it when they fit, otherwise the earlier parts go first as plain text.
function planWhatsappMessages(to: string, message: FounderMessage): Record<string, unknown>[] {
  if (!message.buttons || message.buttons.length === 0) {
    return message.parts.map((part) => textPayload(to, part));
  }
  const merged = message.parts.join("\n\n");
  if (merged.length <= INTERACTIVE_BODY_MAX) {
    return [interactivePayload(to, merged, message.buttons)];
  }
  const leading = message.parts.slice(0, -1).map((part) => textPayload(to, part));
  const last = message.parts[message.parts.length - 1] ?? "";
  const lastBody = last.length <= INTERACTIVE_BODY_MAX ? last : `${last.slice(0, INTERACTIVE_BODY_MAX - 1)}…`;
  return [...leading, interactivePayload(to, lastBody, message.buttons)];
}

async function sendWhatsapp(tenantId: string, message: FounderMessage): Promise<string | null> {
  const to = getFounderPhoneE164();
  if (!to) return "FOUNDER_WHATSAPP_PHONE non configurato o non valido";
  const credentials = getWhatsappCloudApiCredentials();
  if (!credentials) return "WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID non configurati";

  const lastInbound = await getFounderLastInboundAt(tenantId);
  if (!lastInbound || Date.now() - lastInbound.getTime() >= SESSION_WINDOW_MS) {
    return "finestra WhatsApp di 24 ore chiusa (nessun tuo messaggio al numero aziendale nelle ultime 24 ore)";
  }

  try {
    for (const payload of planWhatsappMessages(to, message)) {
      await postWhatsappCloudApiMessage(credentials.accessToken, credentials.phoneNumberId, payload, {
        label: "FounderWhatsapp",
        logName: "founder_whatsapp",
      });
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function sendEmail(message: FounderMessage, whatsappError: string): Promise<string | null> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.MARKETING_ALERT_EMAIL;
  if (!apiKey || !to) return "RESEND_API_KEY o MARKETING_ALERT_EMAIL non configurati";

  const text = [
    ...message.parts,
    "",
    `(Inviato per email perché il WhatsApp non è partito: ${whatsappError})`,
    message.buttons ? FOUNDER_TEXTS.emailFooter : "",
  ]
    .join("\n\n")
    .trim();

  try {
    const { error } = await new Resend(apiKey).emails.send({
      from: process.env.MARKETING_ALERT_FROM_EMAIL ?? "Bonolini BOS <alerts@bonolinitransfer.com>",
      to,
      subject: message.emailSubject,
      text,
    });
    return error ? error.message : null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function sendToFounder(tenantId: string, message: FounderMessage): Promise<FounderDeliveryResult> {
  const whatsappError = await sendWhatsapp(tenantId, message);
  if (whatsappError === null) {
    return { channel: "whatsapp", error: null };
  }

  log("quote_approval.founder_whatsapp_not_sent", { reason: whatsappError });
  const emailError = await sendEmail(message, whatsappError);
  if (emailError === null) {
    return { channel: "email", error: whatsappError };
  }

  const combined = `WhatsApp: ${whatsappError} | Email: ${emailError}`;
  captureException(new Error(combined), "quote_approval.founder_notification_failed");
  return { channel: "none", error: combined };
}
