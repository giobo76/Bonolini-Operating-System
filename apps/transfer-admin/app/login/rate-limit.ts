import { createRateLimiter } from "../../../../packages/core/src/rate-limit";

export const loginRateLimiter = createRateLimiter({ limit: 15, windowMs: 15 * 60_000 });
