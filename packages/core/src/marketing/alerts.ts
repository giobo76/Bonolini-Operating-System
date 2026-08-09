import { Resend } from "resend";
import type { FindingDraft } from "./rule-types";

// Minimal, marketing-specific email sending — not the general-purpose
// notifications module described in docs/domain/10-notifications.md (that's
// still Phase 2+, for booking/client-facing messages). This exists only
// for the two things MIE needs: critical alerts and the weekly digest.
// Silently no-ops (with a console.error) if not configured, rather than
// throwing and failing an entire check run over a missing email setup.

function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

export async function sendCriticalAlertEmail(criticalFindings: FindingDraft[]): Promise<boolean> {
  const resend = getResendClient();
  const alertEmail = process.env.MARKETING_ALERT_EMAIL;

  if (!resend || !alertEmail) {
    console.error(
      "Critical marketing alert NOT sent — RESEND_API_KEY or MARKETING_ALERT_EMAIL not set",
      { count: criticalFindings.length, titles: criticalFindings.map((f) => f.title) },
    );
    return false;
  }

  const body = criticalFindings
    .map(
      (f) =>
        `${f.title}\n${f.observation}\nBusiness impact: ${f.businessImpact}\nRecommended action: ${f.recommendedActions.join("; ")}`,
    )
    .join("\n\n---\n\n");

  const { error } = await resend.emails.send({
    from: process.env.MARKETING_ALERT_FROM_EMAIL ?? "Bonolini Marketing Intelligence <alerts@bonolinitransfer.com>",
    to: alertEmail,
    subject: `🚨 ${criticalFindings.length} critical marketing issue${criticalFindings.length > 1 ? "s" : ""} detected`,
    text: body,
  });

  if (error) {
    console.error("Resend rejected the critical alert email", error);
    return false;
  }
  return true;
}

export async function sendWeeklyDigestEmail(content: string): Promise<boolean> {
  const resend = getResendClient();
  const alertEmail = process.env.MARKETING_ALERT_EMAIL;

  if (!resend || !alertEmail) {
    console.error("Weekly digest NOT sent — RESEND_API_KEY or MARKETING_ALERT_EMAIL not set");
    return false;
  }

  const { error } = await resend.emails.send({
    from: process.env.MARKETING_ALERT_FROM_EMAIL ?? "Bonolini Marketing Intelligence <alerts@bonolinitransfer.com>",
    to: alertEmail,
    subject: "Weekly Marketing Intelligence report",
    text: content,
  });

  if (error) {
    console.error("Resend rejected the weekly digest email", error);
    return false;
  }
  return true;
}
