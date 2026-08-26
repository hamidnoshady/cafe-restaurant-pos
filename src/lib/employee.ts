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
 * Only 'pin' is issuable through `issueCredential` — password credentials
 * stay on the existing platform_users flow. `webauthn` (Wave 3) never joins
 * this list either, but for a different reason than 'password': it's not
 * deferred, it just doesn't fit this function's shape.
 * `issueCredential`/`verifyCredential` are built around a bcrypt-hashed
 * shared secret (the caller presents the same value back to be checked); a
 * WebAuthn credential is an asymmetric keypair proven with a signed
 * challenge, verified by `webauthn.ts`, and stored via
 * `completeWebauthnRegistration`/`verifyWebauthnLogin` instead. The enum
 * carrying all three from Wave 1 is still what let this land as new columns
 * (migration 0043) rather than another migration to add the type.
 */
export const ISSUABLE_CREDENTIAL_TYPES: EmployeeCredentialType[] = ["pin"];

export function isIssuableCredentialType(type: EmployeeCredentialType): boolean {
  return ISSUABLE_CREDENTIAL_TYPES.includes(type);
}

// ---------------------------------------------------------------------------
// Login lockout (Wave 8 — resolves Wave 7's second open question)
// ---------------------------------------------------------------------------

/** A run of this many consecutive failed logins (since the last success or manual clear) locks the employee out. */
import { 
  lockoutStatus as _lockoutStatus, 
  EMPLOYEE_LOCKOUT_POLICY,
  type LoginAttemptEvent, 
  type LockoutStatus 
} from "./login-lockout";

export type { LoginAttemptEvent, LockoutStatus };

export const LOGIN_LOCKOUT_THRESHOLD = 5;
export const LOGIN_LOCKOUT_WINDOW_MINUTES = 15;

export function lockoutStatus(events: LoginAttemptEvent[], now: Date = new Date()): LockoutStatus {
  return _lockoutStatus(events, EMPLOYEE_LOCKOUT_POLICY, now);
}
