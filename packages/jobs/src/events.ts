import { z } from "zod";

// The shared catalog of domain event names this repo's Inngest client can
// carry, per Phase 12 of the BOS Agent build. Defining a name/payload
// schema here does not, by itself, make anything emit or listen to it —
// see each event's own comment for whether a real producer exists yet.
// Centralized so a producer and a consumer (possibly in different modules,
// per ADR 0002's "cross-module only via events" rule) always agree on the
// exact event name and payload shape without importing each other.

export const domainEventNames = [
  // Emitted: social-publishing/service.ts's runWeeklySocialPost and
  // retryFacebookOnly, on their own success/failure outcome (see that
  // module's inngest-functions.ts for the BOS Agent's own listener).
  "social_post.published",
  "social_post.failed",
  // Not yet emitted by any producer — transfer-requests/service.ts is a
  // large, heavily-tested (80+ cases) file; wiring real emission into it
  // safely (plus the matching test mock updates) is deliberately deferred
  // rather than rushed in the same pass as social-publishing's wiring
  // above (see packages/core/src/bos-agent/README.md's "Known gaps").
  // Defined now so a future producer and the BOS Agent's listener already
  // agree on the exact name/payload.
  "transfer_request.created",
  "transfer_request.confirmed",
  // Not yet emitted by any producer — bookings/service.ts's updateBooking
  // is a single generic patch function with no dedicated confirm/complete
  // entry point to hook narrowly without broader, higher-risk changes.
  // Same status as the two transfer_request events above.
  "booking.confirmed",
  "booking.completed",
  // Not yet emitted by any producer — no rule in marketing/ currently
  // raises a dedicated "anomaly" signal distinct from a regular finding
  // (see checkRuns/findings in packages/db/src/schema/marketing.ts). Same
  // status as the two booking events above.
  "marketing.anomaly.detected",
] as const;

export type DomainEventName = (typeof domainEventNames)[number];

export const socialPostPublishedPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  postId: z.string().uuid(),
  weekStartDate: z.string(),
  facebookPostId: z.string().nullable(),
});

export const socialPostFailedPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  postId: z.string().uuid(),
  weekStartDate: z.string(),
  reason: z.string(),
});

export const transferRequestCreatedPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  transferRequestId: z.string().uuid(),
  status: z.string(),
});

export const transferRequestConfirmedPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  transferRequestId: z.string().uuid(),
  finalAmountCents: z.number().int(),
});

export const bookingConfirmedPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  bookingId: z.string().uuid(),
});

export const bookingCompletedPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  bookingId: z.string().uuid(),
});

export const marketingAnomalyDetectedPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  findingId: z.string().uuid(),
  severity: z.string(),
});

export const domainEventPayloadSchemas = {
  "social_post.published": socialPostPublishedPayloadSchema,
  "social_post.failed": socialPostFailedPayloadSchema,
  "transfer_request.created": transferRequestCreatedPayloadSchema,
  "transfer_request.confirmed": transferRequestConfirmedPayloadSchema,
  "booking.confirmed": bookingConfirmedPayloadSchema,
  "booking.completed": bookingCompletedPayloadSchema,
  "marketing.anomaly.detected": marketingAnomalyDetectedPayloadSchema,
} as const satisfies Record<DomainEventName, z.ZodTypeAny>;

export type DomainEventPayload<TName extends DomainEventName> = z.infer<
  (typeof domainEventPayloadSchemas)[TName]
>;

// Fail-soft wrapper around inngest.send() — emitting a domain event is
// always a side effect of an already-completed, already-persisted state
// change (e.g. a post published, a request approved); it must never make
// the caller's own operation fail just because event delivery had a
// transient problem. Validates the payload against its own schema before
// sending, so a producer bug is caught immediately in logs/tests rather
// than silently reaching a listener with a malformed shape.
export async function emitDomainEvent<TName extends DomainEventName>(
  inngest: { send: (event: { name: string; data: unknown }) => Promise<unknown> },
  name: TName,
  data: DomainEventPayload<TName>,
): Promise<void> {
  try {
    domainEventPayloadSchemas[name].parse(data);
    await inngest.send({ name, data });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "jobs.emit_domain_event.failed",
        timestamp: new Date().toISOString(),
        domainEvent: name,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
