import { initTRPC, TRPCError } from "@trpc/server";
import { getSession } from "@bos/auth";
import { captureException, log } from "./observability";

type Session = Awaited<ReturnType<typeof getSession>>;

export interface Context {
  session: Session;
}

export async function createContext(): Promise<Context> {
  const session = await getSession();
  return { session };
}

const t = initTRPC.context<Context>().create();

// Error codes that represent expected, routine rejections (a permission
// check failing, a lookup missing) rather than a bug — logged at info level
// so they don't drown out real failures. Anything else goes to
// captureException. Middleware-based (not errorFormatter-based) so this
// fires identically whether a procedure is called over HTTP
// (/api/trpc/[trpc]) or in-process via createServerCaller() from a Server
// Action/Component — errorFormatter only runs for the HTTP path.
const EXPECTED_TRPC_CODES = new Set(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "BAD_REQUEST", "PARSE_ERROR"]);

const loggingMiddleware = t.middleware(async ({ path, type, ctx, next }) => {
  const tenantId = ctx.session?.profile.tenantId ?? null;
  const start = Date.now();
  log(`trpc.${type}.start`, { path, tenantId });

  const result = await next();
  const durationMs = Date.now() - start;

  if (result.ok) {
    log(`trpc.${type}.success`, { path, tenantId, durationMs });
  } else if (EXPECTED_TRPC_CODES.has(result.error.code)) {
    log(`trpc.${type}.rejected`, { path, tenantId, durationMs, code: result.error.code });
  } else {
    captureException(result.error, `trpc.${type}.failed`, { path, tenantId, durationMs, code: result.error.code });
  }

  return result;
});

const baseProcedure = t.procedure.use(loggingMiddleware);

export const router = t.router;
export const publicProcedure = baseProcedure;

export const protectedProcedure = baseProcedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});

// admin + dispatcher, per docs/domain/09-roles-permissions.md. Driver/client
// scoped procedures don't exist yet — add a separate procedure builder for
// them when a driver- or client-facing module needs one, rather than
// overloading this one.
const STAFF_ROLES = ["admin", "dispatcher"] as const;

export const staffProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!STAFF_ROLES.includes(ctx.session.profile.role as (typeof STAFF_ROLES)[number])) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({ ctx });
});

// admin only — for data more sensitive than day-to-day ops (ad spend,
// marketing strategy). Dispatcher has no reason to see this.
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.session.profile.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({ ctx });
});
