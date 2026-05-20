// Per-DO in-memory token bucket. Per RELAY_BUILD_SPEC.md §9.4 — buckets
// reset on DO eviction; this is anti-spam, not security.

export interface BucketSpec {
  capacity: number;
  refillPerSec: number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export const LIMITS: Record<string, BucketSpec> = {
  send:   { capacity: 30, refillPerSec: 30 / 60 },
  typing: { capacity: 10, refillPerSec: 10 },
  ping:   { capacity: 6,  refillPerSec: 6 / 60 },
  read:   { capacity: 5,  refillPerSec: 5 },
  recall: { capacity: 10, refillPerSec: 10 / 60 },
  edit:   { capacity: 10, refillPerSec: 10 / 60 },
};

export class RateLimiter {
  private buckets = new Map<string, BucketState>();

  consume(key: string, kind: string, cost = 1): boolean {
    const spec = LIMITS[kind];
    if (!spec) return true;
    const id = `${kind}:${key}`;
    const now = Date.now();
    let b = this.buckets.get(id);
    if (!b) {
      b = { tokens: spec.capacity, lastRefillMs: now };
      this.buckets.set(id, b);
    } else {
      const elapsedSec = (now - b.lastRefillMs) / 1000;
      if (elapsedSec > 0) {
        b.tokens = Math.min(spec.capacity, b.tokens + elapsedSec * spec.refillPerSec);
        b.lastRefillMs = now;
      }
    }
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }
}
