export { inngest } from "./client";

// Function *definitions* live in packages/core (e.g.
// packages/core/src/marketing/inngest-functions.ts), not here — they need
// to call into business logic, and packages/core already depends on this
// package for the client. Having jobs depend back on core would be
// circular. This package stays a thin, dependency-free Inngest client only.
