/**
 * Phase 20 Wave 4 — device binding: the framework-free half.
 *
 * A paired POS terminal's bearer token, generated and hashed the same way
 * employee.ts's session token is (see generateSessionToken there) — only the
 * hash is ever persisted (migration 0044), so a database read alone can
 * never yield a usable device token. All the DB-touching work (pairing,
 * listing, revoking, resolving a presented token back to a device) lives in
 * device-service.ts.
 */
import { createHash, randomBytes } from "node:crypto";

/** Prefix makes a leaked token recognisable in a log or a paste. */
const DEVICE_TOKEN_PREFIX = "posdev_";

export function generateDeviceToken(): { token: string; tokenHash: string } {
  const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashDeviceToken(token) };
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
