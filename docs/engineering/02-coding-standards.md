# Coding Standards

Project-specific standards for Phase 1 onward. General engineering preferences (no unnecessary comments, no speculative abstraction, validate only at boundaries) already apply repo-wide per the assistant's operating instructions — this document covers what's specific to *this* codebase.

## TypeScript

- `strict: true` everywhere (already the baseline in `packages/config/tsconfig.base.json`) — never weaken it in an individual package's `tsconfig.json`.
- No `any`. If a type is genuinely unknown (e.g. a third-party webhook payload before validation), use `unknown` and narrow it — typically by parsing it through a Zod schema, which is also where the type comes from.
- Prefer type inference from Zod schemas (`z.infer<typeof schema>`) over hand-written interfaces that duplicate a schema's shape — one definition, not two that can drift.
- Named exports only for shared code (`packages/*`). No default exports outside of Next.js's own conventions (`page.tsx`, `layout.tsx` — where Next.js requires a default export). Named exports are easier to grep for and to refactor safely, which matters more here given a solo dev leaning on AI-assisted search and refactors.

## Validation boundaries

Zod validates at the edges: tRPC procedure inputs, and any external payload (Stripe webhook body, Inngest event payload). Code called *within* `packages/core` from an already-validated tRPC procedure does not re-validate the same data — trust the boundary, per the project's general "don't validate what can't happen" stance.

## Error handling

- Domain rule violations (e.g. assigning an unavailable driver, per [Dispatch Logic](../domain/08-dispatch-logic.md)) throw a `TRPCError` with the appropriate code (`CONFLICT`, `FORBIDDEN`, etc. — see [API Contracts](../domain/13-api-contracts.md#errors)), caught and rendered by the app, not swallowed into a generic "something went wrong."
- Do not add try/catch blocks around code that cannot actually throw in a meaningful way (e.g. wrapping a pure function call "just in case") — matches the project's existing stance against defensive code for scenarios that can't happen.
- External calls that can genuinely fail for reasons outside our control (Stripe, Twilio, Google Maps, Supabase) *do* need explicit error handling, since those are real boundary failure modes, not hypothetical ones.

## State machines

Booking, driver, and invoice statuses (see the respective lifecycle documents under `docs/domain/`) are enforced by an explicit transition table in each module's `service.ts` (`Record<Status, Status[]>` of allowed next-states), not by scattered `if` checks across the codebase — one place to see and change what transitions are legal, matching the state diagrams in the domain docs exactly. If a domain doc's diagram and the code's transition table ever disagree, that's a bug in one of them — fix the actual mismatch, don't silently pick whichever is more convenient.

## Money

All monetary values are stored and computed as integers in the smallest currency unit (cents), never floats — standard practice to avoid rounding errors, and directly relevant given [Pricing Engine](../domain/05-pricing-engine.md)'s multi-step fare computation. Convert to/from display format (`€12.50`) only at the UI edge.

## Dates and times

Store as `timestamptz` (already the pattern in `packages/db`), always reasoned about in UTC internally, converted to Europe/Rome for display — relevant given [Booking Lifecycle](../domain/02-booking-lifecycle.md)'s night/holiday surcharge logic, which depends on correctly localized time, not raw UTC.

## Commits

No fixed conventional-commit format is mandated (solo-dev, low ceremony), but a commit message should say *why* a change was made when that's not obvious from the diff — same "why over what" principle the codebase's code comments follow.

## Before merging to main

Per the [CI skeleton](../../CLAUDE.md#commands) established in Phase 0: typecheck, lint, and test must pass. As real business logic lands in Phase 1, add the `build` step back into CI (deferred in Phase 0 pending real Supabase/Vercel secrets) so a broken build is caught before it reaches production, not after.
