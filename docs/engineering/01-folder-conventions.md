# Folder Conventions

Extends the repository structure already established in [CLAUDE.md](../../CLAUDE.md#repository-structure) with the file-level conventions Phase 1 should follow inside each package.

## Inside a `packages/core` domain module

Each module (`bookings`, `dispatch`, `drivers`, `clients`, `billing`, `notifications`) follows the same internal shape once it has real code:

```
packages/core/src/bookings/
  schema.ts       # Zod schemas for this module's tRPC inputs/outputs
  router.ts       # tRPC router — the module's only public entry point
  service.ts       # business logic (state machine, validation) — called by router.ts
  events.ts        # Inngest event names + payload types this module emits/listens to
  index.ts         # re-exports router + any types other modules are allowed to import
  README.md        # already exists (Phase 0) — keep it accurate as the module fills in
```

`index.ts` is the enforced boundary from [ADR 0002](../adr/0002-modular-monolith-not-microservices.md): other modules (and the apps) may only import from a module's `index.ts`, never reach into `service.ts` or `schema.ts` directly. If another module needs something not currently exported, add it to `index.ts` deliberately — don't reach around it.

## Naming

- **Files:** kebab-case (`booking-state-machine.ts`, not `BookingStateMachine.ts`).
- **React components:** PascalCase filenames matching the component (`BookingForm.tsx`), colocated with the route/feature that uses them under `app/`, or in `packages/ui/src/components/` only once actually shared by both apps — don't pre-emptively move a component to `packages/ui` before a second consumer exists.
- **Variables/functions:** camelCase. **Types/interfaces:** PascalCase. **Zod schemas:** camelCase with a `Schema` suffix (`createBookingSchema`), and the inferred type takes the schema's name minus the suffix (`type CreateBookingInput = z.infer<typeof createBookingSchema>`).
- **Database tables/columns:** snake_case (Postgres convention), mapped to camelCase in Drizzle schema files — already the pattern established in `packages/db/src/schema/` (e.g. `tenant_id` column ↔ `tenantId` field).
- **Inngest event names:** `<module>.<past_tense_event>` (`booking.confirmed`, not `booking.confirm` or `confirmBooking`) — matches the event tables in each lifecycle document under `docs/domain/`.

## Tests

Colocated with the code they test: `service.test.ts` next to `service.ts`, not in a parallel `__tests__` tree — keeps a module's test coverage visible when browsing the module itself. Integration tests that need a real database (per the [testing strategy](../../CLAUDE.md) established at project start) live in the same module, named `*.integration.test.ts` so `vitest run` can filter them separately from fast unit tests if needed.

## Where new domain tables go

One schema file per module in `packages/db/src/schema/`, named after the module (`bookings.ts`, `drivers.ts`, ...), re-exported from `packages/db/src/schema/index.ts` — already the pattern `tenants.ts`/`profiles.ts` established in Phase 0. A module's Drizzle schema and its `packages/core` business logic are separate files in separate packages on purpose (`packages/db` has no business logic; `packages/core` has no direct SQL) — this keeps the modular-monolith boundary enforceable by *where code lives*, not just by convention.

## Apps stay thin

`apps/transfer-web` and `apps/transfer-admin` should contain routing, layout, and presentation only — calling into `packages/core` routers via tRPC. If business logic (a validation rule, a state transition) is being written inside `app/`, it's in the wrong package.
