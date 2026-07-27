/**
 * A fixed-window request counter, plus the small pieces of key-building it
 * needs. Deliberately pure and store-agnostic (the caller owns the Map) so it
 * runs unmodified in `src/middleware.ts`'s Edge runtime, which has no
 * `node:async_hooks` and no database connection — the only state this file
 * ever touches is the Map passed in.
 */

export interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the caller may retry; 0 when allowed. */
  retryAfterMs: number;
}

export function checkRateLimit(
  store: Map<string, RateLimitEntry>,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): RateLimitResult {
  const entry = store.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    store.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (entry.count < limit) {
    entry.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }
  return { allowed: false, retryAfterMs: windowMs - (now - entry.windowStart) };
}

/**
 * Drops entries whose window ended more than `staleAfterMs` ago. The
 * business-keyed store stays small on its own (one entry per business), but
 * the IP- and token-keyed stores grow with every distinct caller ever seen —
 * call this occasionally (not on every request) to keep them bounded.
 */
export function sweepExpired(store: Map<string, RateLimitEntry>, now: number, staleAfterMs: number): void {
  for (const [key, entry] of store) {
    if (now - entry.windowStart > staleAfterMs) store.delete(key);
  }
}

const FNV_OFFSET_BASIS = 0x811c9dc5;

/**
 * Non-cryptographic hash, used only to keep raw bearer tokens out of the
 * rate-limiter's map keys — never for anything security-sensitive (token
 * equality itself is still checked with `tokensMatch`'s timing-safe compare
 * in server-sync.ts). A collision here just buckets two distinct tokens
 * under one counter, making that bucket's effective limit stricter; it can't
 * let a request through that shouldn't be, or leak one token's identity via
 * another's.
 */
export function hashKey(value: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
