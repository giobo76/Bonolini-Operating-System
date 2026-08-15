import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";

// Refreshes the Supabase session cookie on every request and gates all
// routes except the public auth routes below behind an authenticated
// session. No role checks here yet (all authenticated roles can reach the
// placeholder dashboard) — route-level role gating arrives with the real
// dispatch/admin UI as those features are built.
// /api/inngest is included here, not because it's public in the sense of
// human-facing pages, but because Inngest (Cloud or the local Dev Server)
// authenticates its own requests to this route via INNGEST_SIGNING_KEY/
// request signing, never via a Supabase session cookie — gating it behind
// this middleware made it unreachable by Inngest entirely.
//
// /api/marketing/lead-intent is this exact path only, deliberately NOT
// "/api/marketing" — that would also expose /api/marketing/oauth/* and any
// future admin-only marketing route. It's the one endpoint meant to be
// called cross-origin, unauthenticated, from bonolinitransfer.com's own
// tracking script; its own origin allowlisting + rate limiting (see
// packages/core/src/marketing/lead-intent-handler.ts) is the real
// authorization boundary for it, not this exemption by itself.
const PUBLIC_PATHS = [
  "/forgot-password",
  "/reset-password",
  "/auth/confirm",
  "/api/inngest",
  "/api/marketing/lead-intent",
];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      } satisfies CookieMethodsServer,
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isLoginRoute = pathname === "/login";
  const isPublicRoute =
    isLoginRoute || PUBLIC_PATHS.some((path) => pathname.startsWith(path));

  if (!user && !isPublicRoute) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    return NextResponse.redirect(redirectUrl);
  }

  if (user && isLoginRoute) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/";
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
