import { formatAmountForCustomer, formatDateForCustomer } from "../communications";
import type { BusyWindow } from "../availability";

// Pure functions only — no Google, no database. What the booking event
// looks like (founder decisions 2026-09-25). How long it lasts is the
// booking's busy window, from the availability module.

export const CANCELLED_TITLE_PREFIX = "ANNULLATO – ";
// Google Calendar event colour 8, "Graphite": the grey of a cancelled booking.
export const CANCELLED_COLOR_ID = "8";

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
    // Italian customer (+39): never a deposit, pays the driver the whole
    // amount (founder decision 2026-09-26).
    lines.push("Acconto: nessuno (cliente italiano)");
    lines.push(`Da incassare: ${amount(input.totalCents, input.currency)}`);
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
