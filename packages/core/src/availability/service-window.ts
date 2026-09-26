import { z } from "zod";
import { calculateBusyLoopFromBase, type BusyLoopResult } from "../maps-distance";
import { getBusinessRuleByKey } from "../business-rules";
import { captureException } from "../observability";
import { toValidDate } from "../dates";
import {
  computeBusyWindow,
  findRouteMinimum,
  MINIMUM_EVENT_DURATION_RULE_KEY,
  minimumEventDurationRuleContentSchema,
  type BusyWindow,
  type MinimumEventDurationRuleContent,
} from "./busy-window";

// The busy window of one service, with the I/O it needs (Google Maps, the
// minimum-duration Business Rule). Used by the calendar event and by the
// overlap check, so both always agree.

export interface ServiceBusyWindow extends BusyWindow {
  // "Sondrio → Malpensa → Sondrio", or null without Maps.
  loopLabel: string | null;
  loopMinutes: number | null;
  mapsUnavailable: boolean;
  minimumRuleInvalid: boolean;
}

type MinimumRuleResolution = { rule: MinimumEventDurationRuleContent | null; invalid: boolean };

// Missing rule or no effective version: no minimum. Present but unreadable
// (invalid content, several effective versions): no minimum either, and the
// window is "da verificare" — never a silently guessed minimum.
export async function resolveMinimumRule(tenantId: string): Promise<MinimumRuleResolution> {
  const rule = await getBusinessRuleByKey(tenantId, MINIMUM_EVENT_DURATION_RULE_KEY);
  if (!rule) return { rule: null, invalid: false };
  const effective = rule.versions.filter((version) => version.status === "effective");
  if (effective.length === 0) return { rule: null, invalid: false };
  if (effective.length > 1) {
    captureException(
      new Error(`${MINIMUM_EVENT_DURATION_RULE_KEY}: ${effective.length} effective versions`),
      "availability.minimum_rule_invalid",
      { tenantId, ruleId: rule.id },
    );
    return { rule: null, invalid: true };
  }
  const parsed = minimumEventDurationRuleContentSchema.safeParse(effective[0]!.content);
  if (!parsed.success) {
    captureException(new Error(`${MINIMUM_EVENT_DURATION_RULE_KEY}: invalid content`), "availability.minimum_rule_invalid", {
      tenantId,
      ruleId: rule.id,
      versionId: effective[0]!.id,
      zodError: parsed.error.message,
    });
    return { rule: null, invalid: true };
  }
  return { rule: parsed.data, invalid: false };
}

function loopLabel(loop: BusyLoopResult): string | null {
  if (loop.status !== "ok" || loop.legs.length === 0) return null;
  return [loop.legs[0]!.origin, ...loop.legs.map((leg) => leg.destination)].join(" → ");
}

export async function computeServiceBusyWindow(
  tenantId: string,
  input: { pickup: string | null; destination: string | null; pickupAt: Date },
): Promise<ServiceBusyWindow> {
  const loop = input.pickup && input.destination ? await calculateBusyLoopFromBase(input.pickup, input.destination) : null;
  const loopOk = loop !== null && loop.status === "ok";
  const minimumRule = await resolveMinimumRule(tenantId);
  const window = computeBusyWindow({
    pickupAt: input.pickupAt,
    loopMinutes: loopOk ? loop.durationMinutes : null,
    minutesBeforePickup: loopOk ? loop.minutesBeforePickup : null,
    minimum: findRouteMinimum(minimumRule.rule, input.pickup, input.destination),
    minimumRuleInvalid: minimumRule.invalid,
  });
  return {
    ...window,
    loopLabel: loop ? loopLabel(loop) : null,
    loopMinutes: loopOk ? loop.durationMinutes : null,
    mapsUnavailable: !loopOk,
    minimumRuleInvalid: minimumRule.invalid,
  };
}

// JSON form, stored on the booking (bookings.busy_window) and inside the
// round's availability check.
export const storedBusyWindowSchema = z.object({
  startAt: z.string(),
  endAt: z.string(),
  durationToVerify: z.boolean(),
  minimumApplied: z.object({ label: z.string(), minutes: z.number() }).nullable(),
  loopLabel: z.string().nullable(),
  loopMinutes: z.number().nullable(),
  mapsUnavailable: z.boolean(),
  minimumRuleInvalid: z.boolean(),
});
export type StoredBusyWindow = z.infer<typeof storedBusyWindowSchema>;

export function toStoredBusyWindow(window: ServiceBusyWindow): StoredBusyWindow {
  return {
    startAt: window.startAt.toISOString(),
    endAt: window.endAt.toISOString(),
    durationToVerify: window.durationToVerify,
    minimumApplied: window.minimumApplied,
    loopLabel: window.loopLabel,
    loopMinutes: window.loopMinutes,
    mapsUnavailable: window.mapsUnavailable,
    minimumRuleInvalid: window.minimumRuleInvalid,
  };
}

export function fromStoredBusyWindow(value: unknown): ServiceBusyWindow | null {
  const parsed = storedBusyWindowSchema.safeParse(value);
  if (!parsed.success) return null;
  const startAt = toValidDate(parsed.data.startAt);
  const endAt = toValidDate(parsed.data.endAt);
  if (!startAt || !endAt) return null;
  return { ...parsed.data, startAt, endAt };
}
