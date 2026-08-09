// Client-safe entry point ("@bos/auth/client") — for "use client" components
// only. Deliberately excludes ./server and ./session, which import
// "next/headers" and are only valid in Server Components/Actions/Route
// Handlers; importing anything from those in a client bundle is a hard
// build failure, not a runtime one. Re-exports only, no new logic.
export type { Role, Profile } from "./types";
export { createClient as createBrowserClient } from "./client";
