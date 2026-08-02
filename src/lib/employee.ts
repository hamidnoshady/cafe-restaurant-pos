/**
 * Phase 20 Wave 1 — employee identity: the framework-free half.
 *
 * Session-token generation/hashing and the expiry/status rules for a
 * server-side-revocable employee session, plus the credential-type
 * catalogue. Everything that touches the database lives in
 * employee-service.ts; PIN validation itself stays in team.ts (isValidPin)
 * rather than being duplicated here.
 */
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

/** Prefix makes a leaked token recognisable in a log or a paste. */
const SESSION_TOKEN_PREFIX = "empsess_";

/** How long an employee session stays valid without being re-issued. */
export const EMPLOYEE_SESSION_TTL_HOURS = 12;

/**
 * A new session token: the plaintext to hand back to the device, and the
 * hash to store. Only the hash is persisted (migration 0042), matching the
 * server-sync token and public API key pattern — a database read alone can
 * never yield a usable session.
 */
export function generateSessionToken(): { token: string; tokenHash: string } {
  const token = `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + EMPLOYEE_SESSION_TTL_HOURS * 60 * 60 * 1000);
}

export interface SessionState {
  expiresAt: Date | string;
  revokedAt: Date | string | null;
}

export type SessionStatus = "active" | "revoked" | "expired";

/** Why a session can't be used, or "active" when it can. */
export function sessionStatus(session: SessionState, now: Date = new Date()): SessionStatus {
  if (session.revokedAt) return "revoked";
  if (new Date(session.expiresAt).getTime() <= now.getTime()) return "expired";
  return "active";
}

// ---------------------------------------------------------------------------
// Credential types
// ---------------------------------------------------------------------------

export const EMPLOYEE_CREDENTIAL_TYPES = ["pin", "password", "webauthn"] as const;
export type EmployeeCredentialType = (typeof EMPLOYEE_CREDENTIAL_TYPES)[number];

export function isEmployeeCredentialType(value: string): value is EmployeeCredentialType {
  return (EMPLOYEE_CREDENTIAL_TYPES as readonly string[]).includes(value);
}

/**
 * Only 'pin' is issuable through employee-service.ts in Wave 1 — password
 * credentials stay on the existing platform_users flow, and webauthn support
 * arrives in a later wave. The enum already carries all three so
 * employee_credentials.credential_type doesn't need another migration when
 * they do.
 */
export const ISSUABLE_CREDENTIAL_TYPES: EmployeeCredentialType[] = ["pin"];

export function isIssuableCredentialType(type: EmployeeCredentialType): boolean {
  return ISSUABLE_CREDENTIAL_TYPES.includes(type);
}
