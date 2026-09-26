import { z } from "zod";
import { mentionsPlace } from "../locations";

// Pure functions only — no Google, no database. How long the founder is
// busy for one service and whether two services overlap (founder decisions
// 2026-09-25/26). Moved here from the calendar module so the calendar event
// and the overlap check use one definition.

export const FALLBACK_BUSY_MINUTES = 120;

const ROUND_TO_MINUTES = 5;
const MINUTE_MS = 60_000;

// Versioned Business Rule (category "other"): minimum busy time per route,
// e.g. Malpensa in either direction = 5 hours. A route matches when the
// pickup or the destination mentions one of its placeKeywords as a whole
// word; the largest matching minimum wins. The key keeps its original name
// (migration 0031).
export const MINIMUM_EVENT_DURATION_RULE_KEY = "calendar.minimum_event_duration";

export const minimumEventDurationRuleContentSchema = z.object({
  minimums: z.array(
    z.object({
      label: z.string().trim().min(1),
      placeKeywords: z.array(z.string().trim().min(1)).min(1),
      minimumMinutes: z.number().int().positive(),
    }),
  ),
});
export type MinimumEventDurationRuleContent = z.infer<typeof minimumEventDurationRuleContentSchema>;

export interface AppliedMinimum {
  label: string;
  minutes: number;
}

export function findRouteMinimum(
  rule: MinimumEventDurationRuleContent | null,
  pickup: string | null,
  destination: string | null,
): AppliedMinimum | null {
  let best: AppliedMinimum | null = null;
  for (const entry of rule?.minimums ?? []) {
    const matches = entry.placeKeywords.some(
      (keyword) => mentionsPlace(pickup, keyword) || mentionsPlace(destination, keyword),
    );
    if (matches && (!best || entry.minimumMinutes > best.minutes)) {
      best = { label: entry.label, minutes: entry.minimumMinutes };
    }
  }
  return best;
}

export interface BusyWindowInput {
  pickupAt: Date;
  // From maps-distance's calculateBusyLoopFromBase; both null when Google
  // Maps gave no duration.
  loopMinutes: number | null;
  minutesBeforePickup: number | null;
  minimum: AppliedMinimum | null;
  // The minimum-duration rule exists but could not be read (invalid
  // content): the window still gets a duration, flagged to be checked.
  minimumRuleInvalid: boolean;
}

export interface TimeWindow {
  startAt: Date;
  endAt: Date;
}

export interface BusyWindow extends TimeWindow {
  durationToVerify: boolean;
  minimumApplied: AppliedMinimum | null;
}

// The founder is busy from when he leaves Sondrio (pickup time minus the
// empty Sondrio -> pickup leg) until he is back. Rounded outward to 5
// minutes, so the window never looks shorter than the real busy time.
export function computeBusyWindow(input: BusyWindowInput): BusyWindow {
  const fromMaps = input.loopMinutes !== null && input.minutesBeforePickup !== null;
  const rawStart = fromMaps
    ? new Date(input.pickupAt.getTime() - input.minutesBeforePickup! * MINUTE_MS)
    : input.pickupAt;
  let durationMinutes = fromMaps ? input.loopMinutes! : FALLBACK_BUSY_MINUTES;

  let minimumApplied: AppliedMinimum | null = null;
  if (input.minimum && input.minimum.minutes > durationMinutes) {
    durationMinutes = input.minimum.minutes;
    minimumApplied = input.minimum;
  }

  const step = ROUND_TO_MINUTES * MINUTE_MS;
  const startAt = new Date(Math.floor(rawStart.getTime() / step) * step);
  const endAt = new Date(Math.ceil((rawStart.getTime() + durationMinutes * MINUTE_MS) / step) * step);

  return {
    startAt,
    endAt,
    durationToVerify: !fromMaps || input.minimumRuleInvalid,
    minimumApplied,
  };
}

// Overlap = one starts before the other ends. Touching windows (one ends
// exactly when the other starts) do not overlap; back-to-back services
// that share a place still overlap in practice, because each window
// includes the return to Sondrio (founder decision 2026-09-26: flag them).
export function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();
}

export function findOverlaps<T extends TimeWindow>(candidate: TimeWindow, existing: readonly T[]): T[] {
  return existing
    .filter((item) => windowsOverlap(candidate, item))
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}
