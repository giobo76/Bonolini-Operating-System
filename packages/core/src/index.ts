export { appRouter, type AppRouter } from "./router";
export { createContext, type Context } from "./trpc";
export { createServerCaller } from "./caller";
export { log, captureException } from "./observability";
export { createRateLimiter } from "./rate-limit";
export * from "./clients";
export * from "./marketing";
export * from "./quotes";
export * from "./bookings";
export * from "./whatsapp";
export * from "./transfer-requests";
export * from "./pricing";

// Boundary rule (ADR 0002): other modules/apps import only from here (or
// from a module's own index.ts, e.g. "./clients") — never reach into a
// module's router.ts/service.ts directly.
