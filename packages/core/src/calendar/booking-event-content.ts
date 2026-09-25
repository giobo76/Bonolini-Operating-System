import { formatAmountForCustomer, formatDateForCustomer } from "../communications";
import { mentionsPlace } from "../locations";
import type { MinimumEventDurationRuleContent } from "./schema";

// Pure functions only — no Google, no database. What the booking event
// looks like and how long it lasts (founder decisions 2026-09-25).

export const FALLBACK_EVENT_DURATION_MINUTES = 120;
export const CANCELLED_TITLE_PREFIX = "ANNULLATO – ";
// Google Calendar event colour 8, "Graphite": the grey of a cancelled booking.
export const CANCELLED_COLOR_ID = "8";

const ROUND_TO_MINUTES = 5;
const MINUTE_MS = 60_000;

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
  // content): the event still gets a duration, flagged to be checked.
  minimumRuleInvalid: boolean;
}

export interface BusyWindow {
  startAt: Date;
  endAt: Date;
  durationToVerify: boolean;
  minimumApplied: AppliedMinimum | null;
}

// The founder is busy from when he leaves Sondrio (pickup time minus the
// empty Sondrio -> pickup leg) until he is back. Rounded outward to 5
// minutes, so the event never looks shorter than the real busy time.
export function computeBusyWindow(input: BusyWindowInput): BusyWindow {
  const fromMaps = input.loopMinutes !== null && input.minutesBeforePickup !== null;
  const rawStart = fromMaps
    ? new Date(input.pickupAt.getTime() - input.minutesBeforePickup! * MINUTE_MS)
    : input.pickupAt;
  let durationMinutes = fromMaps ? input.loopMinutes! : FALLBACK_EVENT_DURATION_MINUTES;

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

export interface BookingEventContentInput {
  transferRequestRef: string;
  clientName: string;
  clientPhone: string;
  pickup: string;
  destination: string;
  requestedDate: string | null;
  requestedTime: string | null;
  passengers: number | null;
  children: number | null;
  childrenAges: string | null;
  luggage: string | null;
  flightNumber: string | null;
  trainNumber: string | null;
  hotel: string | null;
  totalCents: number;
  depositCents: number | null;
  currency: string;
  loopLabel: string | null;
  loopMinutes: number | null;
  window: BusyWindow;
  mapsUnavailable: boolean;
}

// "€390" as the founder writes it in his own events; decimals only when
// there are some.
function titlePrice(cents: number, currency: string): string {
  if (currency !== "EUR") return formatAmountForCustomer(cents, currency, "it");
  const euros = cents / 100;
  return Number.isInteger(euros) ? `€${euros}` : `€${euros.toFixed(2).replace(".", ",")}`;
}

function amount(cents: number, currency: string): string {
  return formatAmountForCustomer(cents, currency, "it");
}

function displayPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  return digits ? `+${digits}` : phone;
}

function childrenLine(children: number | null, ages: string | null): string {
  if (children === null) return "non indicato";
  if (children === 0) return "nessuno";
  return ages ? `${children} (età: ${ages})` : `${children} (età non indicata)`;
}

function hoursAndMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

export function buildBookingEventTitle(input: { clientName: string; pickup: string; destination: string; totalCents: number; currency: string }): string {
  return `TRANSFER | ${input.clientName} | ${input.pickup} → ${input.destination} | ${titlePrice(input.totalCents, input.currency)}`;
}

export function buildBookingEventDescription(input: BookingEventContentInput): string {
  const when = input.requestedDate
    ? `${formatDateForCustomer(input.requestedDate)}${input.requestedTime ? ` ore ${input.requestedTime}` : ""}`
    : "non indicata";

  const lines = [
    `Cliente: ${input.clientName}`,
    `Telefono: ${displayPhone(input.clientPhone)}`,
    `Tratta: ${input.pickup} → ${input.destination}`,
    `Ritiro: ${when}`,
    `Passeggeri: ${input.passengers ?? "non indicato"}`,
    `Bambini: ${childrenLine(input.children, input.childrenAges)}`,
    `Bagagli: ${input.luggage ?? "non indicato"}`,
    `Volo: ${input.flightNumber ?? "non indicato"}`,
  ];
  if (input.trainNumber) lines.push(`Treno: ${input.trainNumber}`);
  if (input.hotel) lines.push(`Hotel: ${input.hotel}`);

  lines.push(`Prezzo totale: ${amount(input.totalCents, input.currency)}`);
  if (input.depositCents !== null) {
    lines.push(`Acconto ricevuto: ${amount(input.depositCents, input.currency)}`);
    lines.push(`Saldo da incassare: ${amount(input.totalCents - input.depositCents, input.currency)}`);
  } else {
    lines.push("Acconto: non registrato");
  }

  lines.push("");
  if (input.loopMinutes !== null && input.loopLabel) {
    lines.push(`Tempo occupato: ${input.loopLabel}, circa ${hoursAndMinutes(input.loopMinutes)} (Google Maps)`);
  }
  if (input.window.minimumApplied) {
    lines.push(
      `Durata minima applicata: ${hoursAndMinutes(input.window.minimumApplied.minutes)} (${input.window.minimumApplied.label})`,
    );
  }
  if (input.window.durationToVerify) {
    lines.push(
      input.mapsUnavailable
        ? "Durata da verificare: Google Maps non ha dato la durata del giro."
        : "Durata da verificare: la regola delle durate minime non è leggibile.",
    );
  }

  lines.push("");
  lines.push(`Creato dal BOS (rif. ${input.transferRequestRef}). Modificare o cancellare questo evento non cambia la prenotazione nel BOS.`);
  return lines.join("\n");
}

export function cancelledTitle(summary: string | null | undefined): string {
  const current = summary ?? "";
  return current.startsWith(CANCELLED_TITLE_PREFIX) ? current : `${CANCELLED_TITLE_PREFIX}${current}`;
}
