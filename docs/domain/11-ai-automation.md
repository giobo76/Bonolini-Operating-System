# AI Automation Opportunities

Distinct from [CLAUDE.md's AI integration strategy](../../CLAUDE.md) (which covers AI *building* this software) — this document is about AI as a *product feature* within Bonolini Transfer's operations, and explicitly the bridge to the future AI Automation Agency (see [docs/future-agency.md](../future-agency.md)): whatever proves useful here is a live prototype of what the agency would eventually sell to other SMBs.

None of this is Phase 1 scope. Listed here, ranked by when it becomes plausible, so it isn't lost — and so Phase 1's schema isn't accidentally built in a way that forecloses it.

## Near-term (Phase 2 candidates)

- **Special-request structuring.** `booking.special_requests` is free text (see [Business Entities](01-business-entities.md)). An LLM pass could extract structured signals (child seat needed, wheelchair access, extra stop) into fields dispatch/drivers actually see instead of hoping someone reads the free text. Low risk (assistive, human-reviewed), clear value.
- **Client communication drafting.** Non-standard situations (reschedule requests, complaints) drafted by Claude for admin review before sending — speeds up response without removing the human from client-facing communication, which matters for a premium chauffeur brand.
- **Flight-aware pickup adjustment.** `booking.flight_number` (airport transfers) could be checked against a flight-status API, with Claude drafting a proactive "your flight is delayed, we've adjusted your pickup" message. Real value, moderate complexity (external flight data dependency, not just an LLM call).

## Mid-term (Phase 3+ candidates)

- **Dispatch ranking assistance.** Once [assisted matching](08-dispatch-logic.md#phase-2-assisted-matching) exists, an LLM could explain *why* a candidate is ranked where it is in natural language for the dispatcher — a UX layer on top of the ranking logic, not a replacement for it.
- **Demand forecasting.** Predicting busy periods from historical booking patterns to help the founder plan driver availability — useful once there's enough historical `bookings` data to forecast from (not before).
- **Anomaly/fraud signals.** Flagging unusual patterns (e.g. a `client` repeatedly cancelling near pickup time, a driver with unusual gaps between `en_route`/`arrived` timestamps) for admin review — assistive flagging, not automated blocking.

## Long-term / agency-facing

- The tooling built for Bonolini Transfer's own internal ops (a dispatcher-assist copilot, an automated client-communication layer, a WhatsApp-based booking assistant) is directly the kind of product the AI Automation Agency would offer other small/medium businesses. Building it well for Transfer first, then generalizing, is explicitly the intended path — not two separate efforts. See [docs/future-agency.md](../future-agency.md#what-it-will-likely-need-when-built-phase-4).

## Explicit non-goals for now

- **Fully autonomous dispatch or pricing decisions.** Every item above keeps a human in the loop (draft-for-review, flag-for-review, rank-for-a-human-to-pick). Removing the human is a much bigger trust/liability step for a premium chauffeur brand and isn't being designed for yet.
- **Chatbot replacing human booking entirely.** A booking-assistant chatbot (Phase 2+ near-term item above) augments the web/phone/WhatsApp channels; it isn't intended to be the only way to book.

## Implementation note (for whenever this is built)

Per [CLAUDE.md](../../CLAUDE.md#tech-stack), build directly on the Claude API / Claude Agent SDK rather than a third-party agent orchestration framework — consistent with the rest of the stack's "minimal moving parts for a solo operator" philosophy.
