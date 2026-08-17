/**
 * The *shape* of a public API key, split out from api-auth.ts.
 *
 * api-auth.ts is the authentication realm: it imports `node:crypto`, the pg
 * pool and the tenant context, so nothing on a browser bundle's import path
 * may reach it. Two things do need the format alone — connection-code.ts,
 * which tells the desktop pair form that a `posk_live_…` is not a pairing
 * code, and the connections dashboard, which renders a key's non-secret
 * prefix. Both are client-side, so the format lives here and api-auth.ts
 * re-exports it for its existing importers.
 */

/** Namespaces a public API key, so a tenant or platform credential pasted by mistake is rejected before any lookup. */
export const API_KEY_PREFIX = "posk_live_";

/** How much of a key is safe to store and show: the prefix plus a little, never enough to authenticate. */
export const API_KEY_DISPLAY_PREFIX_LENGTH = 16;

/** The non-secret identifier persisted alongside the hash and shown in the dashboard. */
export function apiKeyDisplayPrefix(secret: string): string {
  return secret.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH);
}

/** Whether a pasted value is even shaped like a public API key. Format only — never an authentication decision. */
export function looksLikeApiKey(raw: string): boolean {
  return raw.trim().startsWith(API_KEY_PREFIX);
}
