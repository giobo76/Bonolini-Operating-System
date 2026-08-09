import { createRateLimiter } from "../../../../packages/core/src/rate-limit";

export const submitLeadRateLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
