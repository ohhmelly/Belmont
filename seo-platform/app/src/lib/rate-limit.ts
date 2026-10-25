/**
 * Phase 7 security fix: a small, dependency-free, in-memory burst rate
 * limiter for server actions that are expensive to run but aren't
 * already covered by Better Auth's own rate limiter (which only sits
 * in front of its own HTTP routes under /api/auth/*, not this app's
 * Server Actions).
 *
 * This app's Phase 6 monthly manual-crawl quota (`assertCanRunManualCrawl`
 * in billing/quota.ts) stops someone from running more crawls than their
 * plan allows over a month, but it does nothing to stop a short burst —
 * e.g. a misbehaving script hammering `triggerCrawl` 50 times in one
 * second, each one spawning a real siteone-crawler subprocess on the
 * worker before the monthly counter even catches up (crawl jobs are
 * counted from completed/enqueued rows, not blocked synchronously at
 * the instant of insert). This module adds that missing per-actor,
 * per-minute burst cap.
 *
 * Deliberately NOT Redis/Postgres-backed: this is a single-instance,
 * self-hosted deployment (per the project's own architecture decisions
 * — see docs/ARCHITECTURE.md and docker-compose.yml's own comments
 * about not needing Redis for pg-boss either). An in-memory sliding-
 * window-ish counter, scoped per Node process, is correct for that
 * target and avoids adding a dependency or a new table for something
 * this simple. It resets on restart, which is an acceptable trade-off
 * for a burst limiter (unlike the auth/session store, which must
 * survive restarts and already lives in Postgres).
 */

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

/** Evicts expired buckets so this Map can't grow without bound across a long-running process. */
function prune(now: number, maxAgeMs: number): void {
  if (buckets.size < 10_000) return; // cheap check first; avoid pruning on every call
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > maxAgeMs) buckets.delete(key);
  }
}

export class RateLimitError extends Error {
  readonly status = 429;
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Fixed-window limiter: `max` calls per `windowMs` per `key`. Returns
 * nothing on success; throws `RateLimitError` (with a human-readable
 * message and `retryAfterSeconds`) once `key` has used up its budget
 * for the current window. Exported as a check-and-consume primitive —
 * callers decide the key (e.g. `${action}:${userId}`) and limits.
 */
export function checkRateLimit(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  prune(now, windowMs);

  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return;
  }

  if (existing.count >= max) {
    const retryAfterSeconds = Math.ceil((existing.windowStart + windowMs - now) / 1000);
    throw new RateLimitError(
      `Too many requests — please wait ${retryAfterSeconds}s before trying again.`,
      Math.max(1, retryAfterSeconds)
    );
  }

  existing.count += 1;
}

/** Test-only: clears all buckets so tests don't bleed into each other via this module's shared state. */
export function __resetRateLimitsForTests(): void {
  buckets.clear();
}
