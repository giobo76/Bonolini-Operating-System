// Structured, provider-agnostic observability layer (Production Roadmap
// Milestone 1.3 error monitoring + 1.4 structured logging — the two share
// one context-tagging convention on purpose, per the roadmap's own note).
//
// log() covers routine/info events (a check started, a procedure
// succeeded). captureException() covers failures and is the single call
// site a real monitoring provider (Sentry or otherwise) gets wired into
// later — see docs/PRODUCTION_ROADMAP.md#13-error-monitoring. No SDK is
// configured today: structured console output is the real monitoring
// signal until a provider is chosen, so every call site here already
// produces the log lines a future provider integration would forward.

type LogContext = Record<string, unknown>;

const SENSITIVE_KEY_PATTERN = /token|secret|password|apikey|api_key|credential/i;

function redact(context: LogContext): LogContext {
  const safe: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    safe[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : value;
  }
  return safe;
}

export function log(event: string, context: LogContext = {}): void {
  console.log(
    JSON.stringify({
      level: "info",
      event,
      timestamp: new Date().toISOString(),
      ...redact(context),
    }),
  );
}

export function captureException(error: unknown, event: string, context: LogContext = {}): void {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      timestamp: new Date().toISOString(),
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
      ...redact(context),
    }),
  );
  // No provider configured yet — this is intentionally the one place a real
  // SDK call (e.g. Sentry.captureException(error, { contexts: { app:
  // context } })) gets added later, without touching any caller above.
}
