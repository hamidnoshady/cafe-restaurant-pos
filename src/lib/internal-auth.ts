/**
 * The shared secret that lets Edge middleware call a Node-runtime route.
 *
 * Phase 24 Wave 5 moved the rate-limit counters from per-process `Map`s into
 * Postgres, which the Edge runtime cannot reach — it has no `pg` and no
 * `node:async_hooks`. The counter therefore lives behind an internal API
 * route that middleware calls over HTTP.
 *
 * That call arrives with no session, because it is made *for* requests that
 * have none (a login attempt is the whole point of the IP bucket), so the
 * route cannot use any of the four normal guards. Without a credential of its
 * own it would be an open endpoint that writes caller-supplied keys and
 * counts into a shared table: anyone who could reach it could exhaust another
 * IP's login bucket to lock them out, or reset their own to walk straight
 * past the brute-force limiter.
 *
 * So middleware signs each call with a secret only the server knows. It is
 * derived from JWT_SECRET rather than being a new deployment variable on
 * purpose — every install already has one, and inventing another env var
 * would mean every existing deployment silently falls back to the in-memory
 * limiter after upgrading. The derivation keeps it distinct from the value
 * used to sign sessions, exactly as `jwt-secret.ts` separates its realms.
 *
 * Both sides run inside the same server, so this authenticates "this call
 * came from our own middleware" and nothing more. It is not a user
 * credential and must never be treated as one.
 */

const INTERNAL_HEADER = "x-internal-auth";
const DERIVATION_LABEL = "pos-internal-route-v1";

/** Header name middleware sets and the internal route checks. */
export const INTERNAL_AUTH_HEADER = INTERNAL_HEADER;

/**
 * HMAC-SHA256 of a fixed label under JWT_SECRET, hex encoded.
 *
 * Uses WebCrypto rather than `node:crypto` because middleware runs in the
 * Edge runtime, where the Node module is unavailable — this same function has
 * to produce the same string on both sides.
 */
export async function internalAuthToken(): Promise<string | null> {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === "change-me-in-production") return null;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(DERIVATION_LABEL));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Length-independent, byte-wise comparison.
 *
 * Both operands here are fixed-length hex digests, so the length check leaks
 * nothing, and the loop keeps a wrong guess from being distinguishable by how
 * early it diverged.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Whether a request carries the internal-call credential. */
export async function isInternalCall(headers: Headers): Promise<boolean> {
  const presented = headers.get(INTERNAL_HEADER);
  if (!presented) return false;
  const expected = await internalAuthToken();
  // No usable JWT_SECRET means no internal calls are authenticated at all,
  // rather than every call being accepted.
  if (!expected) return false;
  return timingSafeEqualHex(presented, expected);
}
