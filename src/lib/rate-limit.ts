/**
 * A fixed-window request counter, plus the small pieces of key-building it
 * needs. Deliberately pure and store-agnostic (the caller owns the Map) so it
 * runs unmodified in `src/middleware.ts`'s Edge runtime, which has no
 * `node:async_hooks` and no database connection — the only state this file
 * ever touches is the Map passed in.
 */

import { INTERNAL_AUTH_HEADER, internalAuthToken } from "./internal-auth";

export interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export function clientIpFrom(headers: Headers, trustedHops: number): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",").map((s) => s.trim());
    const index = Math.max(0, parts.length - 1 - trustedHops);
    return parts[index];
  }
  
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp;

  return "unknown";
}

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the caller may retry; 0 when allowed. */
  retryAfterMs: number;
}

/**
 * The durable counter is best-effort: if it cannot be reached the limiter still
 * works, just per-process again. That degradation must be *visible* — it
 * silently reinstates the reset-on-restart, per-replica behaviour Wave 5 exists
 * to remove — but logging a stack trace on every single request turns one
 * misconfiguration into an unreadable log and a performance problem of its own.
 * So: complain immediately, then at a decreasing rate.
 */
let durableFailures = 0;

function noteDurableFailure(reason: string): void {
  durableFailures += 1;
  const isPowerOfTen = /^10*$/.test(String(durableFailures));
  if (durableFailures === 1 || isPowerOfTen) {
    console.error(
      `rate-limit: durable (Postgres) counter unreachable — falling back to the per-process ` +
        `counter, which resets on restart and is not shared across replicas. ` +
        `Occurrence ${durableFailures}. Reason: ${reason}`,
    );
  }
}

export async function checkRateLimit(
  _store: Map<string, RateLimitEntry> | null,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
  requestUrl?: string,
): Promise<RateLimitResult> {
  // Phase 24 Wave 5 — the durable counter lives in Postgres, which this (Edge)
  // runtime cannot reach, so it is asked for over HTTP. The call is signed
  // with the internal secret because the endpoint writes a shared table and
  // has no session to authenticate: see src/lib/internal-auth.ts.
  //
  // `now` is deliberately NOT sent. The window is anchored on the database
  // clock; letting the caller supply the time let a forged call rewind its own
  // window forever. It stays in the signature for the in-memory fallback
  // below, which is per-process and has no such exposure.
  //
  // INTERNAL_BASE_URL overrides the origin for deployments where the request's
  // own origin is not reachable from inside the runtime — behind a proxy that
  // terminates a public hostname the container cannot resolve, for instance.
  try {
    const token = await internalAuthToken();
    if (token) {
      const configured = process.env.INTERNAL_BASE_URL?.trim();
      const origin = configured || (requestUrl ? new URL(requestUrl).origin : "http://127.0.0.1:3000");
      const res = await fetch(`${origin}/api/internal/rate-limit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [INTERNAL_AUTH_HEADER]: token },
        body: JSON.stringify({ key, limit, windowMs }),
      });
      if (res.ok) {
        durableFailures = 0;
        return (await res.json()) as RateLimitResult;
      }
      noteDurableFailure(`HTTP ${res.status}`);
    } else {
      noteDurableFailure("no JWT_SECRET, so the internal call cannot be signed");
    }
  } catch (err) {
    noteDurableFailure(err instanceof Error ? err.message : String(err));
  }

  // Memory fallback if fetch fails
  const store = _store || new Map();
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
