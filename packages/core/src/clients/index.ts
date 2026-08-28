export { clientsRouter } from "./router";
export { getClient } from "./service";
export * from "./schema";
export * from "./constants";
export { buildAttributionCookieValue, parseAttributionCookie, resolveAttribution } from "./attribution";
export type { AttributionFields, AttributionCookiePayload } from "./attribution";
export type { Client, NewClient } from "@bos/db";

// getClient is exported here (in addition to the router) so other core
// modules can read a client by id through this module's public boundary
// per ADR 0002 — e.g. transfer-requests needs a client's phone to derive
// customerType, and reaching into clients/service.ts directly would have
// violated the module boundary rule. No new logic: this re-exports the
// existing read-only function, unchanged.
