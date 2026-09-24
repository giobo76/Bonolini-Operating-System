import { normalizePhone } from "../whatsapp";
import { log } from "../observability";

// Two production switches, read on every call (no caching), so a change in
// Vercel takes effect with the next deploy and nothing else.
//
// QUOTE_APPROVAL_ENABLED — anything but the exact string "true" turns the
// whole flow off: the webhook behaves exactly as before this module existed
// (the founder's number is treated like any other sender, nobody receives
// anything automatic).
//
// QUOTE_APPROVAL_TEST_PHONES — when set, the flow only acts for these
// customer numbers (comma/space/semicolon separated, E.164). Every other
// customer gets nothing automatic and produces no PREVENTIVO PRONTO. Fails
// closed: if it is set but contains no valid number, nobody is allowed.

const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

export function isQuoteApprovalEnabled(): boolean {
  return process.env.QUOTE_APPROVAL_ENABLED === "true";
}

// null = no restriction (variable unset or empty).
function getTestPhones(): Set<string> | null {
  const raw = process.env.QUOTE_APPROVAL_TEST_PHONES?.trim();
  if (!raw) return null;

  const phones = new Set<string>();
  for (const entry of raw.split(/[\s,;]+/)) {
    if (!entry) continue;
    if (E164_PATTERN.test(entry)) {
      phones.add(normalizePhone(entry));
    } else {
      log("quote_approval.invalid_test_phone_ignored", { entryLength: entry.length });
    }
  }
  return phones;
}

// Base URL of the admin panel, for the links in the founder's emails (e.g.
// https://bonolini-operating-system-transfer.vercel.app). null = emails go
// out without links.
export function getAdminBaseUrl(): string | null {
  const raw = process.env.ADMIN_BASE_URL?.trim();
  if (!raw || !/^https?:\/\//.test(raw)) return null;
  return raw.replace(/\/+$/, "");
}

export function adminLink(path: string): string | null {
  const base = getAdminBaseUrl();
  return base ? `${base}${path}` : null;
}

// FOUNDER_NOTIFICATION_EMAIL, falling back to MARKETING_ALERT_EMAIL.
export function getFounderNotificationEmail(): string | null {
  const own = process.env.FOUNDER_NOTIFICATION_EMAIL?.trim();
  if (own) return own;
  const fallback = process.env.MARKETING_ALERT_EMAIL?.trim();
  return fallback ? fallback : null;
}

export function isCustomerPhoneAllowed(phone: string): boolean {
  const testPhones = getTestPhones();
  if (testPhones === null) return true;
  return testPhones.has(normalizePhone(phone));
}
