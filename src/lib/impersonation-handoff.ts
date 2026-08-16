/**
 * Phase 23 follow-up — the one-time token that carries an impersonation
 * session from the console's host (admin.{ROOT_DOMAIN}) to the business's own
 * origin, where the host-scoped tenant cookie can actually be minted.
 *
 * Framework-free and dependency-light (only node:crypto) so it is directly
 * unit-testable, matching the sibling patterns in employee.ts (session
 * tokens), device.ts (pairing tokens) and api-auth.ts (API keys): the
 * plaintext is returned exactly once and only its SHA-256 hash is persisted.
 */
import { createHash, randomBytes } from "node:crypto";

/** Prefix makes a leaked token recognisable in a log or a paste. */
export const IMPERSONATION_HANDOFF_PREFIX = "impho_";

/**
 * How long a handoff token stays redeemable, in minutes. Deliberately tiny: it
 * only has to survive one browser hop from the console to the business host,
 * and a short window means a token leaked from a log or history entry stops
 * working almost immediately.
 */
export const IMPERSONATION_HANDOFF_TTL_MINUTES = 5;

/** A new handoff token: the plaintext for the URL, and the hash to store. */
export function generateImpersonationHandoffToken(): { token: string; tokenHash: string } {
  const token = `${IMPERSONATION_HANDOFF_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashImpersonationHandoffToken(token) };
}

export function hashImpersonationHandoffToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
