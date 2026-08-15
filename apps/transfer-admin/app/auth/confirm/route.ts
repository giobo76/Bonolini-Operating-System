import { type NextRequest, NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@bos/auth";

// Handles Supabase email-link verification (password recovery today; also
// covers invite/magic-link if those are added later, since they use the
// same token_hash + type pattern). Requires the Supabase project's "Reset
// Password" email template to point here — see docs in the login flow
// setup notes.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/";

  const supabase = await createServerSupabaseClient();

  // PKCE flow (default for @supabase/ssr): Supabase's standard
  // {{ .ConfirmationURL }} email template redirects here with `code` as a
  // query param after verifying the OTP server-side — this is the path a
  // stock (non-custom) email template actually produces.
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, request.url));
    }
  } else if (tokenHash && type) {
    // Fallback: a custom email template using {{ .TokenHash }} directly,
    // bypassing Supabase's hosted verify hop. Not in use today (the
    // project's plan doesn't allow custom email templates), kept so this
    // route needs no further changes if that ever becomes available.
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });

    if (!error) {
      return NextResponse.redirect(new URL(next, request.url));
    }
  }

  return NextResponse.redirect(
    new URL("/login?error=invalid_or_expired_link", request.url),
  );
}
