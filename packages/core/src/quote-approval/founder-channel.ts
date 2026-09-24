import { Resend } from "resend";
import { getWhatsappCloudApiCredentials, isE164, postWhatsappCloudApiMessage } from "../communications";
import { normalizePhone } from "../whatsapp";
import { log, captureException } from "../observability";
import { toValidDate } from "../dates";
import { getFounderLastInboundAt } from "./repository";
import { getFounderNotificationEmail } from "./config";
import { FOUNDER_TEXTS } from "./content";

// Delivery of messages to the founder.
//
// Default (FOUNDER_WHATSAPP_PHONE empty, the founder's decision of
// 2026-09-24): email only, via Resend, to FOUNDER_NOTIFICATION_EMAIL (or
// MARKETING_ALERT_EMAIL). No WhatsApp attempt of any kind, no error logged
// for it. Decisions are taken in the admin panel, linked from the email.
//
// If FOUNDER_WHATSAPP_PHONE is ever set: WhatsApp first (only inside Meta's
// 24h window, which applies to the founder too), email as fallback.

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
  // Link to the admin panel page for this message, when ADMIN_BASE_URL is set.
  link?: { label: string; url: string } | null;
  emailSubject: string;
}

export type FounderDeliveryResult =
  | { channel: "whatsapp"; error: null }
  | { channel: "email"; error: string | null }
  | { channel: "none"; error: string };

export function getFounderPhoneE164(): string | null {
  const raw = process.env.FOUNDER_WHATSAPP_PHONE;
  if (!raw || !raw.trim()) return null;
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

function withLink(message: FounderMessage): string[] {
  return message.link ? [...message.parts, `${message.link.label}: ${message.link.url}`] : message.parts;
}

// Button messages carry one body of at most 1024 chars: parts are merged
// into it when they fit, otherwise the earlier parts go first as plain text.
function planWhatsappMessages(to: string, message: FounderMessage): Record<string, unknown>[] {
  const parts = withLink(message);
  if (!message.buttons || message.buttons.length === 0) {
    return parts.map((part) => textPayload(to, part));
  }
  const merged = parts.join("\n\n");
  if (merged.length <= INTERACTIVE_BODY_MAX) {
    return [interactivePayload(to, merged, message.buttons)];
  }
  const leading = parts.slice(0, -1).map((part) => textPayload(to, part));
  const last = parts[parts.length - 1] ?? "";
  const lastBody = last.length <= INTERACTIVE_BODY_MAX ? last : `${last.slice(0, INTERACTIVE_BODY_MAX - 1)}…`;
  return [...leading, interactivePayload(to, lastBody, message.buttons)];
}

async function sendWhatsapp(tenantId: string, to: string, message: FounderMessage): Promise<string | null> {
  const credentials = getWhatsappCloudApiCredentials();
  if (!credentials) return "WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID non configurati";

  const lastInbound = toValidDate(await getFounderLastInboundAt(tenantId));
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

async function sendEmail(message: FounderMessage, whatsappError: string | null): Promise<string | null> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = getFounderNotificationEmail();
  if (!apiKey || !to) return "RESEND_API_KEY o FOUNDER_NOTIFICATION_EMAIL/MARKETING_ALERT_EMAIL non configurati";

  const footer: string[] = [];
  if (message.link) {
    footer.push(`${message.link.label}:\n${message.link.url}`);
  } else if (message.buttons) {
    footer.push(FOUNDER_TEXTS.noAdminLink);
  }
  if (whatsappError) {
    footer.push(`(Inviato per email perché il WhatsApp non è partito: ${whatsappError})`);
    if (message.buttons) footer.push(FOUNDER_TEXTS.emailFooter);
  }

  const text = [...message.parts, ...footer].join("\n\n").trim();

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
  const founderPhone = getFounderPhoneE164();

  let whatsappError: string | null = null;
  if (founderPhone) {
    whatsappError = await sendWhatsapp(tenantId, founderPhone, message);
    if (whatsappError === null) {
      return { channel: "whatsapp", error: null };
    }
    log("quote_approval.founder_whatsapp_not_sent", { reason: whatsappError });
  }

  const emailError = await sendEmail(message, whatsappError);
  if (emailError === null) {
    return { channel: "email", error: whatsappError };
  }

  const combined = whatsappError ? `WhatsApp: ${whatsappError} | Email: ${emailError}` : `Email: ${emailError}`;
  captureException(new Error(combined), "quote_approval.founder_notification_failed");
  return { channel: "none", error: combined };
}
