/**
 * The signed envelope the WordPress plugin and this app exchange, and the
 * token that keys it.
 *
 * Pure (only `node:crypto`), so it is unit-tested directly while the service
 * that stores and looks things up is not — the same split
 * `webhook-signature.ts` / `webhook-ingest-service.ts` already uses.
 *
 * ## Why not just a bearer token
 *
 * A bearer token alone is enough for confidentiality over TLS, and that is
 * what `/api/v1` uses. This channel asks for more because of what sits on both
 * ends: a WordPress install — historically the most-compromised software on
 * the public internet — talking to a system that posts journal entries. So
 * every request carries three things beyond the token:
 *
 *  - a **timestamp**, checked against a five-minute window, so a captured
 *    request stops working almost immediately;
 *  - a **nonce**, recorded per connection, so it does not work even twice
 *    inside that window (see `integration_plugin_nonces`);
 *  - an **HMAC over the exact bytes of the body**, so a proxy that can see the
 *    request cannot alter the order total on its way through.
 *
 * The token is both the identifier and the HMAC key. That is deliberate: one
 * secret to configure, one to rotate, and no second field for an owner to
 * paste into the wrong box — which is the failure this whole area is being
 * fixed for.
 *
 * ## The signing string
 *
 *     v1:{timestamp}:{nonce}:{sha256hex(rawBody)}
 *
 * The body is hashed rather than concatenated so the string is a fixed length
 * regardless of payload size, and the three variable fields are separated by a
 * character that cannot appear in any of them (timestamps and the body hash
 * are hex/decimal; the nonce charset is enforced below), so no two different
 * request triples can produce the same signing string.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Namespaces the credential, the way `posk_live_` namespaces an API key. */
export const PLUGIN_TOKEN_PREFIX = "wplink_";

export const PLUGIN_SIGNATURE_HEADER = "x-pos-signature";
export const PLUGIN_TIMESTAMP_HEADER = "x-pos-timestamp";
export const PLUGIN_NONCE_HEADER = "x-pos-nonce";

/** How far a request's clock may be from ours, either way. WordPress hosts drift. */
export const PLUGIN_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/** Version marker on the signing string, so a future scheme is detectably different rather than silently wrong. */
const SIGNATURE_VERSION = "v1";

const NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** A fresh link token. 32 bytes of entropy; the prefix is not part of the secret's strength. */
export function generatePluginToken(): string {
  return PLUGIN_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Only this is stored — matching how server-sync tokens and API keys are kept. */
export function hashPluginToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function looksLikePluginToken(raw: string): boolean {
  return raw.trim().startsWith(PLUGIN_TOKEN_PREFIX);
}

/** The exact string both sides sign. Exported so the PHP side has one authoritative definition to mirror. */
export function pluginSigningString(timestamp: string, nonce: string, rawBody: string): string {
  const bodyHash = createHash("sha256").update(rawBody, "utf8").digest("hex");
  return `${SIGNATURE_VERSION}:${timestamp}:${nonce}:${bodyHash}`;
}

export function pluginSignature(token: string, timestamp: string, nonce: string, rawBody: string): string {
  return createHmac("sha256", token).update(pluginSigningString(timestamp, nonce, rawBody)).digest("hex");
}

export type PluginEnvelopeError =
  | "missing_signature"
  | "missing_timestamp"
  | "missing_nonce"
  | "bad_nonce"
  | "stale_timestamp"
  | "bad_signature";

export interface PluginEnvelope {
  timestamp: string;
  nonce: string;
}

export type VerifyPluginEnvelopeResult =
  | { ok: true; envelope: PluginEnvelope }
  | { ok: false; error: PluginEnvelopeError };

/**
 * Verify one request's envelope against a known token.
 *
 * Order matters and is not arbitrary: the cheap structural checks run first so
 * a malformed request never reaches the HMAC, and the *timestamp* is checked
 * before the signature so a replayed-but-correctly-signed request is reported
 * as stale rather than as valid. The nonce is not checked here — that needs
 * the database — but its charset is, because it goes into the signing string
 * and into a primary key.
 */
export function verifyPluginEnvelope(
  token: string,
  headers: {
    signature: string | null;
    timestamp: string | null;
    nonce: string | null;
  },
  rawBody: string,
  now: number,
): VerifyPluginEnvelopeResult {
  const signature = headers.signature?.trim().replace(/^sha256=/i, "") ?? "";
  const timestamp = headers.timestamp?.trim() ?? "";
  const nonce = headers.nonce?.trim() ?? "";

  if (!signature) return { ok: false, error: "missing_signature" };
  if (!timestamp) return { ok: false, error: "missing_timestamp" };
  if (!nonce) return { ok: false, error: "missing_nonce" };
  if (!NONCE_RE.test(nonce)) return { ok: false, error: "bad_nonce" };

  // Milliseconds since the epoch, as sent. A non-numeric value is "stale"
  // rather than its own error: it is not a distinction worth telling an
  // unauthenticated caller about, and there is nothing else it could be.
  const sent = Number(timestamp);
  if (!Number.isFinite(sent) || Math.abs(now - sent) > PLUGIN_TIMESTAMP_SKEW_MS) {
    return { ok: false, error: "stale_timestamp" };
  }

  const expected = pluginSignature(token, timestamp, nonce, rawBody);
  // Both sides are fixed-length hex from the same function, so the lengths
  // always match and timingSafeEqual cannot throw — but a caller-supplied
  // signature of a different length would, hence the guard before it.
  if (signature.length !== expected.length) return { ok: false, error: "bad_signature" };
  if (!timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))) {
    return { ok: false, error: "bad_signature" };
  }

  return { ok: true, envelope: { timestamp, nonce } };
}
