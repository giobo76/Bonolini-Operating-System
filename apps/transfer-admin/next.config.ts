import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// Next.js only auto-loads .env* files from this app's own directory, but the
// monorepo keeps a single .env.local at the repo root (no per-app env files,
// to avoid duplicating secrets). Load it explicitly, the same way Next's own
// CLI would, so dev/build/start all see it identically — cwd here is always
// apps/transfer-admin (pnpm --filter runs from here), so root is two levels up.
// forceReload is required: Next's CLI already calls loadEnvConfig once against
// this app's own (root-less) directory before next.config.ts runs, and
// @next/env caches that result — without forceReload, this call is a no-op.
loadEnvConfig(path.join(process.cwd(), "..", ".."), process.env.NODE_ENV !== "production", console, true);

// packages/auth/src/client.ts's browser Supabase client calls
// NEXT_PUBLIC_SUPABASE_URL directly from client-side JS (login/session
// refresh) — that origin must be allow-listed or auth breaks silently.
// Guarded so `next build` with no env vars set (see .github/workflows/ci.yml's
// zero-env-var build) never throws.
const supabaseOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin
  : "";

// next dev's webpack runtime executes modules via eval() for fast HMR and
// inline source maps (webpack_exec) — script-src must allow 'unsafe-eval'
// for that, but only in development: production bundles are precompiled
// and never use eval, so relaxing this in production would weaken the CSP
// for no reason.
const isDev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${supabaseOrigin ? ` ${supabaseOrigin}` : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

const nextConfig: NextConfig = {
  transpilePackages: ["@bos/ui", "@bos/auth", "@bos/core", "@bos/db", "@bos/jobs"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
