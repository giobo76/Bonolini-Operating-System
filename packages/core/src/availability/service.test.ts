import { describe, expect, it } from "vitest";
import {
  BASE_LOCATION,
  OPERATIONAL_BUFFER_MINUTES,
  determineRelocationOrigin,
  calculateServiceEndAt,
  calculateVehicleReadyAt,
  isServiceFeasible,
  estimateVehicleFreeAt,
  type PreviousService,
} from "./index";

// Pure module, no @bos/db mock needed — same discipline as pricing/service.test.ts.

function dt(iso: string): Date {
  return new Date(iso);
}

describe("constants", () => {
  it("operational buffer is 60 minutes (founder-confirmed)", () => {
    expect(OPERATIONAL_BUFFER_MINUTES).toBe(60);
  });

  it("base location is Sondrio", () => {
    expect(BASE_LOCATION).toBe("Sondrio");
  });
});

describe("determineRelocationOrigin", () => {
  // 7
  it("7: with no previous service, the origin is Sondrio (the base)", () => {
    expect(determineRelocationOrigin(null)).toBe("Sondrio");
    expect(determineRelocationOrigin(null)).toBe(BASE_LOCATION);
  });

  // 6 (part 1)
  it("6: with a previous service, the origin is its destination — never Sondrio, no return-to-base assumption", () => {
    const previous: PreviousService = {
      startAt: dt("2026-09-20T08:00:00"),
      pickup: "Sondrio",
      destination: "Malpensa",
      customerTripDurationMinutes: 150,
    };
    expect(determineRelocationOrigin(previous)).toBe("Malpensa");
    expect(determineRelocationOrigin(previous)).not.toBe(BASE_LOCATION);
  });
});

describe("calculateServiceEndAt / calculateVehicleReadyAt (primitives)", () => {
  it("adds a duration in minutes to a start time", () => {
    expect(calculateServiceEndAt(dt("2026-09-20T08:00:00"), 150)).toEqual(dt("2026-09-20T10:30:00"));
  });

  // 9
  it("9: calculateVehicleReadyAt adds relocation + the 60-minute buffer, isolated from relocation itself", () => {
    const serviceEndAt = dt("2026-09-20T13:00:00");
    // relocation = 0 isolates the buffer's own contribution.
    const readyAt = calculateVehicleReadyAt(serviceEndAt, 0, OPERATIONAL_BUFFER_MINUTES);
    expect(readyAt).toEqual(dt("2026-09-20T14:00:00"));
    expect(readyAt.getTime() - serviceEndAt.getTime()).toBe(60 * 60_000);
  });

  // 11
  it("11: date arithmetic correctly crosses midnight", () => {
    const endAt = calculateServiceEndAt(dt("2026-09-20T23:00:00"), 90); // 90 min past 23:00
    expect(endAt).toEqual(dt("2026-09-21T00:30:00"));
    expect(endAt.getDate()).toBe(21);

    const readyAt = calculateVehicleReadyAt(endAt, 30, 60);
    expect(readyAt).toEqual(dt("2026-09-21T02:00:00"));
  });
});

describe("estimateVehicleFreeAt", () => {
  // 1 — the exact worked example from the spec.
  it("1: Sondrio -> Malpensa, 08:00, 150min trip, 150min return, 60min buffer -> free at 14:00", () => {
    const result = estimateVehicleFreeAt({
      candidate: { startAt: dt("2026-09-20T08:00:00"), pickup: "Sondrio", destination: "Malpensa" },
      customerTripDurationMinutes: 150,
      returnToBaseDurationMinutes: 150,
    });

    expect(result.serviceEndAt).toEqual(dt("2026-09-20T10:30:00"));
    expect(result.returnToBaseDurationMinutes).toBe(150);
    expect(result.operationalBufferMinutes).toBe(60);
    expect(result.estimatedVehicleFreeAt).toEqual(dt("2026-09-20T14:00:00"));
  });
});

describe("isServiceFeasible", () => {
  function previousEndingAt(destination: string, endAt: string, customerTripDurationMinutes = 60): PreviousService {
    // startAt is back-derived so previousServiceEndAt lands exactly on endAt —
    // isServiceFeasible only ever uses startAt + duration, never a direct "end" field.
    const startAt = new Date(dt(endAt).getTime() - customerTripDurationMinutes * 60_000);
    return { startAt, pickup: "irrelevant-for-these-tests", destination, customerTripDurationMinutes };
  }

  // 7
  it("7: with no previous service, feasible is always true and reports 'no_previous_service'", () => {
    const result = isServiceFeasible({
      candidate: { startAt: dt("2026-09-20T09:00:00"), pickup: "Malpensa", destination: "Sondrio" },
      previousService: null,
    });

    expect(result.feasible).toBe(true);
    expect(result.reason).toBe("no_previous_service");
    expect(result.customerTripDurationMinutes).toBeNull();
    expect(result.vehicleRelocationDurationMinutes).toBeNull();
    expect(result.vehicleReadyAt).toBeNull();
    expect(result.marginMinutes).toBeNull();
    expect(result.operationalBufferMinutes).toBe(60);
    // Candidate fields are still reported, for traceability.
    expect(result.candidatePickup).toBe("Malpensa");
    expect(result.candidateDestination).toBe("Sondrio");
  });

  // 2
  it("2: previous service ends at Aprica 13:00, new pickup Sondrio 14:30, relocation 60min -> readyAt 15:00, NOT feasible", () => {
    const result = isServiceFeasible({
      candidate: { startAt: dt("2026-09-20T14:30:00"), pickup: "Sondrio", destination: "Tirano" },
      previousService: previousEndingAt("Aprica", "2026-09-20T13:00:00"),
      relocationDurationMinutes: 60,
    });

    expect(result.vehicleReadyAt).toEqual(dt("2026-09-20T15:00:00"));
    expect(result.feasible).toBe(false);
    expect(result.reason).toBe("insufficient_operational_margin");
    expect(result.marginMinutes).toBe(-30);
  });

  // 3
  it("3: same case but pickup at 15:00 -> feasible exactly on the boundary (margin 0)", () => {
    const result = isServiceFeasible({
      candidate: { startAt: dt("2026-09-20T15:00:00"), pickup: "Sondrio", destination: "Tirano" },
      previousService: previousEndingAt("Aprica", "2026-09-20T13:00:00"),
      relocationDurationMinutes: 60,
    });

    expect(result.vehicleReadyAt).toEqual(dt("2026-09-20T15:00:00"));
    expect(result.feasible).toBe(true);
    expect(result.reason).toBe("within_operational_margin");
    expect(result.marginMinutes).toBe(0);
  });

  // 4
  it("4: Aprica -> Milano, relocation 120min, buffer 60min -> margin computed correctly", () => {
    const result = isServiceFeasible({
      candidate: { startAt: dt("2026-09-20T16:45:00"), pickup: "Milano", destination: "Sondrio" },
      previousService: previousEndingAt("Aprica", "2026-09-20T13:00:00"),
      relocationDurationMinutes: 120,
    });

    // readyAt = 13:00 + 120min + 60min = 16:00
    expect(result.vehicleReadyAt).toEqual(dt("2026-09-20T16:00:00"));
    expect(result.feasible).toBe(true);
    expect(result.marginMinutes).toBe(45);
  });

  // 5
  it("5: previous service ends at Malpensa, new pickup also Malpensa, relocation 0 -> only the buffer applies", () => {
    const result = isServiceFeasible({
      candidate: { startAt: dt("2026-09-20T11:00:00"), pickup: "Malpensa", destination: "Sondrio" },
      previousService: previousEndingAt("Malpensa", "2026-09-20T10:00:00"),
      relocationDurationMinutes: 0,
    });

    expect(result.vehicleRelocationDurationMinutes).toBe(0);
    // readyAt = 10:00 + 0 + 60 = 11:00 — the entire gap is the buffer.
    expect(result.vehicleReadyAt).toEqual(dt("2026-09-20T11:00:00"));
    expect(result.feasible).toBe(true);
    expect(result.marginMinutes).toBe(0);
  });

  // 6 (part 2 — the numeric side of the "no Sondrio assumption" guarantee)
  it("6: previous service ends at Malpensa, new pickup Milano — uses the given relocation as-is, never a Sondrio detour", () => {
    const previous = previousEndingAt("Malpensa", "2026-09-20T10:00:00");
    expect(determineRelocationOrigin(previous)).toBe("Malpensa");

    const result = isServiceFeasible({
      candidate: { startAt: dt("2026-09-20T12:00:00"), pickup: "Milano", destination: "Sondrio" },
      previousService: previous,
      relocationDurationMinutes: 45, // Malpensa -> Milano, supplied by the caller
    });

    // readyAt = 10:00 + 45 + 60 = 11:45 — no trace of a Sondrio round trip anywhere.
    expect(result.vehicleReadyAt).toEqual(dt("2026-09-20T11:45:00"));
    expect(result.vehicleRelocationDurationMinutes).toBe(45);
  });

  // 8
  it("8: customerTripDuration and relocationDuration are always distinct fields, never merged or swapped", () => {
    const result = isServiceFeasible({
      candidate: { startAt: dt("2026-09-20T13:00:00"), pickup: "Milano", destination: "Sondrio" },
      previousService: previousEndingAt("Malpensa", "2026-09-20T10:00:00", 90), // customerTripDurationMinutes = 90
      relocationDurationMinutes: 45, // deliberately a different value
    });

    expect(result.customerTripDurationMinutes).toBe(90);
    expect(result.vehicleRelocationDurationMinutes).toBe(45);
    expect(result.customerTripDurationMinutes).not.toBe(result.vehicleRelocationDurationMinutes);
    // readyAt only ever depends on the previous service's END (start + its
    // own 90min trip, already baked into previousEndingAt's 10:00) plus the
    // 45min relocation + 60min buffer — the 90 never re-enters the sum here.
    expect(result.vehicleReadyAt).toEqual(dt("2026-09-20T11:45:00"));
    expect(result.vehicleReadyAt).toEqual(new Date(dt("2026-09-20T10:00:00").getTime() + (45 + 60) * 60_000));
  });

  // 10
  it("10: positive, zero, and negative margins are all reported correctly", () => {
    const previous = previousEndingAt("Aprica", "2026-09-20T13:00:00");

    const positive = isServiceFeasible({
      candidate: { startAt: dt("2026-09-20T15:30:00"), pickup: "Sondrio", destination: "Tirano" },
      previousService: previous,
      relocationDurationMinutes: 60,
    });
    expect(positive.marginMinutes).toBe(30);
    expect(positive.feasible).toBe(true);

    const zero = isServiceFeasible({
      candidate: { startAt: dt("2026-09-20T15:00:00"), pickup: "Sondrio", destination: "Tirano" },
      previousService: previous,
      relocationDurationMinutes: 60,
    });
    expect(zero.marginMinutes).toBe(0);
    expect(zero.feasible).toBe(true);

    const negative = isServiceFeasible({
      candidate: { startAt: dt("2026-09-20T14:00:00"), pickup: "Sondrio", destination: "Tirano" },
      previousService: previous,
      relocationDurationMinutes: 60,
    });
    expect(negative.marginMinutes).toBe(-60);
    expect(negative.feasible).toBe(false);
  });

  // 11 (isServiceFeasible's own midnight-crossing case, in addition to the primitive-level one above)
  it("11b: feasibility check itself is correct across a midnight boundary", () => {
    const previous = previousEndingAt("Aprica", "2026-09-20T23:30:00", 30); // startAt 23:00, ends 23:30
    const result = isServiceFeasible({
      candidate: { startAt: dt("2026-09-21T01:00:00"), pickup: "Sondrio", destination: "Tirano" },
      previousService: previous,
      relocationDurationMinutes: 30,
    });

    // readyAt = 23:30 + 30min + 60min = 01:00 the next day.
    expect(result.vehicleReadyAt).toEqual(dt("2026-09-21T01:00:00"));
    expect(result.feasible).toBe(true);
    expect(result.marginMinutes).toBe(0);
  });

  // 12
  describe("12: invalid/incoherent input produces a structured error, never an invented result", () => {
    it("throws on a negative customerTripDurationMinutes", () => {
      expect(() =>
        isServiceFeasible({
          candidate: { startAt: dt("2026-09-20T12:00:00"), pickup: "Milano", destination: "Sondrio" },
          previousService: { ...previousEndingAt("Malpensa", "2026-09-20T10:00:00"), customerTripDurationMinutes: -5 },
          relocationDurationMinutes: 30,
        }),
      ).toThrow(/customerTripDurationMinutes/);
    });

    it("throws on a negative relocationDurationMinutes", () => {
      expect(() =>
        isServiceFeasible({
          candidate: { startAt: dt("2026-09-20T12:00:00"), pickup: "Milano", destination: "Sondrio" },
          previousService: previousEndingAt("Malpensa", "2026-09-20T10:00:00"),
          relocationDurationMinutes: -10,
        }),
      ).toThrow(/relocationDurationMinutes/);
    });

    it("throws when relocationDurationMinutes is omitted but a previousService is given", () => {
      expect(() =>
        isServiceFeasible({
          candidate: { startAt: dt("2026-09-20T12:00:00"), pickup: "Milano", destination: "Sondrio" },
          previousService: previousEndingAt("Malpensa", "2026-09-20T10:00:00"),
        }),
      ).toThrow(/relocationDurationMinutes is required/);
    });

    it("throws on an empty candidate.pickup", () => {
      expect(() =>
        isServiceFeasible({
          candidate: { startAt: dt("2026-09-20T12:00:00"), pickup: "  ", destination: "Sondrio" },
          previousService: null,
        }),
      ).toThrow(/pickup/);
    });

    it("throws on an empty previousService.destination", () => {
      expect(() =>
        isServiceFeasible({
          candidate: { startAt: dt("2026-09-20T12:00:00"), pickup: "Milano", destination: "Sondrio" },
          previousService: { ...previousEndingAt("Malpensa", "2026-09-20T10:00:00"), destination: "" },
          relocationDurationMinutes: 30,
        }),
      ).toThrow(/destination/);
    });

    it("throws on an invalid candidate.startAt", () => {
      expect(() =>
        isServiceFeasible({
          candidate: { startAt: new Date("not-a-date"), pickup: "Milano", destination: "Sondrio" },
          previousService: null,
        }),
      ).toThrow(/startAt/);
    });

    it("estimateVehicleFreeAt also rejects a negative duration", () => {
      expect(() =>
        estimateVehicleFreeAt({
          candidate: { startAt: dt("2026-09-20T08:00:00"), pickup: "Sondrio", destination: "Malpensa" },
          customerTripDurationMinutes: -1,
          returnToBaseDurationMinutes: 150,
        }),
      ).toThrow(/customerTripDurationMinutes/);
    });
  });
});
