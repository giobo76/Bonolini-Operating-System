import { appRouter } from "./router";
import { createContext } from "./trpc";

// For Server Components/Server Actions in the same Next.js app: calls the
// router directly in-process, no HTTP round-trip. The /api/trpc route
// (apps/*/app/api/trpc/[trpc]/route.ts) exposes the same appRouter over
// HTTP for anything that isn't the app itself (a future mobile client,
// webhooks, direct testing).
export async function createServerCaller() {
  const ctx = await createContext();
  return appRouter.createCaller(ctx);
}
