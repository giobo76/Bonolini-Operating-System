type RateLimitKey = string;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const entries = new Map<RateLimitKey, RateLimitEntry>();

function getWindowStart(now: number, windowMs: number): number {
  return now - (now % windowMs);
}

export function createRateLimiter(options: { limit: number; windowMs: number }) {
  const { limit, windowMs } = options;

  return function consume(key: string, now = Date.now()): { ok: boolean; remaining: number; resetAt: number } {
    const windowStart = getWindowStart(now, windowMs);
    const bucketKey = `${key}:${windowStart}`;
    const current = entries.get(bucketKey);

    if (!current || current.resetAt <= now) {
      const nextEntry: RateLimitEntry = { count: 1, resetAt: now + windowMs };
      entries.set(bucketKey, nextEntry);
      return { ok: true, remaining: Math.max(0, limit - 1), resetAt: nextEntry.resetAt };
    }

    if (current.count >= limit) {
      return { ok: false, remaining: 0, resetAt: current.resetAt };
    }

    current.count += 1;
    return { ok: true, remaining: Math.max(0, limit - current.count), resetAt: current.resetAt };
  };
}
