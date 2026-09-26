# calendar — Google Calendar as a real-conversion source, never a second source of truth

**Status:** Core v1 — Calendar sync (Calendar → bookings, the Real Conversion System) plus, since 2026-09-25, one narrow write path: an event for each booking confirmed after the deposit or after "Confermato dal cliente" (BOS → Calendar), marked "ANNULLATO" when the booking is cancelled in BOS. Nothing else in BOS writes to Google Calendar; no event is ever deleted.

**Owns:** the `calendar_connections` table — one row per tenant, which Google Calendar was explicitly selected as "the Bonolini Transfer services calendar," plus this module's own sync bookkeeping (`syncToken`, `lastSyncedAt`, `lastSyncStatus`, `lastSyncError`).

**Exposes:** `listAvailableCalendars`, `getCalendarConfig`, `selectCalendar`, `syncCalendarEvents`, `createCalendarEventForBooking`, `markCalendarEventCancelledForBooking` — plus the pure parser `parseCalendarEvent`/`isRecognizableService` and the pure event builders in `booking-event.ts` (exported for testing). A minimal tRPC router (`calendarRouter`) exposes the first four, all `adminProcedure`.

**Emits/Listens to:** a periodic Inngest cron (`calendarSync`, every 15 minutes); listens to `booking.confirmed` (creates the booking's event) and `booking.cancelled` (marks it "ANNULLATO") — see `inngest-functions.ts`.

See [ADR 0002](../../../../docs/adr/0002-modular-monolith-not-microservices.md) for the module boundary rules this module follows: it never reaches into `clients`/`bookings`/`marketing` internals, only their own exported interfaces (`../clients`, `../bookings`, `../marketing`).

## Why bookings.status, not a parallel conversion table

The Real Conversion System (`packages/core/src/marketing/business-kpis.ts`'s `getRealConversionSummary`) already reads `bookings.status` (`confirmed | completed | cancelled`) as the one, real, idempotent source of truth for a commercial conversion. This module's entire job is to keep `bookings` populated from Google Calendar — it never computes a conversion, a revenue figure, or an attribution decision itself. Creating/updating a `bookings` row **is** registering the real conversion; there is no second table, no duplicate metric, no parallel logic to keep in sync.

## Write access: one narrow path, owned by this module

Until 2026-09-25 this module was read-only by design. The founder then asked for the booking to appear in the calendar by itself, so the write path below exists — and only this one.

**Scopes.** `calendar.readonly` (for `calendarList.list()`, which `calendar.events` does not cover) plus `calendar.events` (events only — not the full `calendar` scope, which could also change calendars, sharing and settings). Both live on the shared Google connection in `apps/transfer-admin/app/api/marketing/oauth/start/route.ts`; the marketing checks stay read-only in their own code, the Calendar write calls exist only in `booking-event.ts`. Adding the scope means the founder reconnects Google once from /marketing/connections; until then the create call fails with a permission error, is retried by Inngest, and logged — the booking itself stays confirmed.

**Calls.** `events.insert()` when a booking is confirmed, `events.get()` + `events.patch()` when it is cancelled in BOS. Never `events.delete()`, never any other event.

**Which bookings.** Only bookings that come from a transfer request, when they become confirmed: after the deposit for a foreign customer (`confirmBookingDeposit`), after "Confermato dal cliente" for an italian one (`confirmBookingByCustomer`, no deposit — founder decision 2026-09-26). Both emit `booking.confirmed`. A booking that already has a `calendar_event_id` (it came from Calendar in the first place) is skipped: its event already exists.

**The event** (founder decisions 2026-09-25):

- Title `TRANSFER | Mario Rossi | Malpensa → Sondrio | €390` — with the price: the calendar is seen by the founder only.
- Description: customer, phone, route, pickup date and time, passengers, children, luggage, flight/train/hotel when known, total price, deposit received, balance to collect. For an italian customer: "Acconto: nessuno (cliente italiano)" and "Da incassare: <total>".
- Time = the whole time the founder is busy: the booking's busy window (`availability`'s busy window, stored on the booking at Approva — the same one the overlap check used; computed on the spot for a booking that has none): the loop Sondrio → pickup → destination → Sondrio from Google Maps, starting when he has to leave Sondrio, rounded outward to 5 minutes.
- Minimum durations per route come from the versioned Business Rule `calendar.minimum_event_duration` (category `other`; seeded by migration `0031`: Malpensa, either direction, 5 hours). New minimums for other routes are a new rule version, not code.
- If Google Maps gives no duration: pickup time + 2 hours (never less than the route minimum) and "Durata da verificare" in the description. Same note if the minimum-duration rule is present but invalid.

**Never a second booking.** Three independent guards: the event carries `extendedProperties.private.bosBookingId`, and the sync ignores every such event; its id is derived from the booking id (`bos` + the booking uuid's 32 hex digits, valid Google base32hex), so the sync also recognizes it when Google returns a deleted event with nothing but its id, and a retried insert gets 409 instead of a duplicate; the booking stores the id in `calendar_event_id` (unique).

**BOS is the source of truth for its own events.** If the founder edits or deletes a BOS-created event in Google, the booking in BOS does not change (founder decision 2026-09-25) — the sync skips those events in every state, cancelled included.

**Cancellation in BOS.** `updateBooking` to `cancelled` emits `booking.cancelled`; the event is kept, its title gets the prefix "ANNULLATO – " and its colour becomes grey (Google colorId 8, Graphite). A cancelled booking never gets a new event. Events not created by BOS are never modified.

## The Bonolini calendar is explicit, never inferred

`selectCalendar()` persists exactly the `googleCalendarId` the admin picked from `listAvailableCalendars()`'s real results — never a guessed or hardcoded ID. Every sync operates on that one calendar only. Selecting a different calendar clears the stored `syncToken`, forcing a controlled full resync of the newly selected calendar rather than resuming a token that belonged to a different one.

## Recognizing a commercial event

Two gates, in order:

1. **Which calendar it's in** — only events on the explicitly selected calendar are ever considered at all.
2. **A recognizable route** — `parseCalendarEvent()` requires a `Pickup → Destination` (or `->`) arrow somewhere in the event summary. An event with no route (`isRecognizableService()` returns false) is counted as `eventsIgnoredNotAService` and never touches `bookings` — a "Dentist appointment" on the same calendar is real calendar noise, not a service.

The suggested format (`TRANSFER | Mario Rossi | Milano → Tirano | €390`) is a **preference, not a hard requirement**: the parser only imposes the route arrow as structure. Client name is extracted from the pipe-delimited format specifically (the one non-route, non-price, non-"TRANSFER" segment); price is extracted only as a bare `€<integer>` (e.g. `€390`) — any format with a decimal or thousands separator (`€390,00`, `€1.200`) is genuinely ambiguous and is **never guessed**, left `null` instead. Phone/email/gclid/utm fields are read from simple `Key: value` lines in the event **description**, never invented.

## The real, honest limitation: a client needs a phone

`clients.phone` is `NOT NULL` and unique-per-tenant (`clients_tenant_normalized_phone_idx`). If an event's description carries no extractable phone line and no existing booking already links this event to a client, this module **cannot** create a valid client — and therefore cannot create a booking. That event is counted as `eventsSkippedNoClientData`, never silently dropped, never given an invented phone number. The practical implication: a calendar event needs at least a `Phone: ...` line (and, for a genuinely new customer, a name in the pipe-delimited format) to auto-create a booking. This is a deliberate, documented constraint, not an oversight.

## Reading events for the overlap check

`listCalendarBusyEvents` (read-only, `events.list` with `timeMin`/`timeMax`, `singleEvents`) returns the events of the selected calendar overlapping a time range, for the overlap check in PREVENTIVO PRONTO. It skips cancelled events, events marked "Libero" (transparent) and events created by BOS. All-day events count as the whole day in Europe/Rome. No calendar selected, or Google unreachable, is reported as such — never as "no events".

## Idempotency

`bookings.calendar_event_id` is `unique` (migration `0015`). `ensureBookingFromCalendarEvent` (in `../bookings/service.ts`) uses the same `INSERT ... ON CONFLICT DO UPDATE` technique already established by `ensureBookingForApprovedTransferRequest` — a given Google Calendar event can never produce more than one booking, and a repeated or retried sync of the same event converges on the same row. `client_id` and `status` are **never** touched on conflict/update — only descriptive fields (`pickup`, `destination`, `scheduled_at`, `final_amount_cents`, `currency`) are refreshed. Client resolution reuses `clients`' own atomic `findOrCreateClientByPhone` (the same partial-unique-index technique WhatsApp intake already uses), so a concurrent sync can never create two clients for the same phone either.

## Sync modes: incremental and full

`syncCalendarEvents()` uses Google's `syncToken` for incremental sync whenever one is stored — only events that actually changed since the last sync are returned. The very first sync for a newly selected calendar (no `syncToken` yet) is a **full sync**, bounded to a 90-day lookback (`FULL_SYNC_LOOKBACK_DAYS`) rather than pulling a calendar's entire history. If Google rejects a stored `syncToken` as invalid/expired (HTTP 410), this module clears it and performs exactly one bounded, controlled full resync in the same call — never an unbounded retry loop.

## Cancellation, never deletion

A Google Calendar event whose `status` is `"cancelled"` (returned by `events.list` for both incremental and full sync) is matched by `calendar_event_id` and moves the existing booking to `status = 'cancelled'` — the row is **never deleted**. A cancelled booking is excluded from `getRealConversionSummary`'s real-conversion/revenue counts (unchanged logic — this module doesn't touch that function) but stays in the historical record.

## Completed is never automatic

This module only ever sets a new booking's status to its column default (`confirmed`) or moves an existing one to `cancelled`. It never sets `completed` — per the founder's explicit rule, marking a service as actually delivered stays a deliberate, separate action (today: `bookings.update`'s existing admin patch mutation), not something a calendar sync infers from a date having passed.

## Sync frequency

Every 15 minutes (`*/15 * * * *`, `inngest-functions.ts`'s `calendarSync`) — near-real-time without hammering the Calendar API's quota. A manual "Sync now" (the `syncNow` tRPC mutation, same underlying function) is also available from the dashboard for an immediate sync.

## Calendar is never required

A tenant with no `calendar_connections` row configured is a fast, silent no-op for every sync run (`syncCalendarEvents` returns an all-zero result immediately) — nothing in the rest of BOS depends on Calendar being connected.

## Not built yet (explicitly out of scope this milestone)

Structured `pickupAddress`/`destinationAddress`/`passengers` extraction from event descriptions (only the route/price/contact/attribution fields above are parsed); recurring-event-aware handling beyond `singleEvents: true`; any write beyond the booking event above (no event updates when a confirmed booking's time or price changes, no events for bookings without a transfer request); automatic Google Ads offline-conversion upload from a calendar-sourced booking (the Real Conversion System is an internal measurement only — see `business-kpis.ts`).
