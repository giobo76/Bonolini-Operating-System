import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, createContext } from "@bos/core";

// Same appRouter the app itself calls in-process via createServerCaller()
// (packages/core/src/caller.ts) — this HTTP endpoint is for callers outside
// this Next.js process (future mobile client, webhooks, direct testing),
// per docs/domain/13-api-contracts.md.
function handler(request: Request) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext,
  });
}

export { handler as GET, handler as POST };
