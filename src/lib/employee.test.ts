import { describe, expect, it } from "vitest";
import {
  EMPLOYEE_CREDENTIAL_TYPES,
  EMPLOYEE_SESSION_TTL_HOURS,
  LOGIN_LOCKOUT_THRESHOLD,
  LOGIN_LOCKOUT_WINDOW_MINUTES,
  generateSessionToken,
  hashSessionToken,
  isEmployeeCredentialType,
  isIssuableCredentialType,
  lockoutStatus,
  sessionExpiry,
  sessionStatus,
  type LoginAttemptEvent,
} from "./employee";

describe("session tokens", () => {
  it("returns a prefixed token and its hash, never storing the plaintext", () => {
    const { token, tokenHash } = generateSessionToken();
    expect(token.startsWith("empsess_")).toBe(true);
    expect(tokenHash).toBe(hashSessionToken(token));
    expect(tokenHash).not.toContain(token.slice(8));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates a distinct token every time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateSessionToken().token));
    expect(tokens.size).toBe(50);
  });

  it("hashes deterministically so a presented token can be looked up", () => {
    expect(hashSessionToken("empsess_abc")).toBe(hashSessionToken("empsess_abc"));
    expect(hashSessionToken("empsess_abc")).not.toBe(hashSessionToken("empsess_abd"));
  });
});

describe("session expiry", () => {
  it("expires the configured number of hours out", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const expiry = sessionExpiry(now);
    expect(expiry.getTime() - now.getTime()).toBe(EMPLOYEE_SESSION_TTL_HOURS * 60 * 60 * 1000);
  });
});

describe("sessionStatus", () => {
  const now = new Date("2026-01-01T12:00:00Z");

  it("is active when not revoked and not yet expired", () => {
    expect(
      sessionStatus({ expiresAt: "2026-01-01T18:00:00Z", revokedAt: null }, now),
    ).toBe("active");
  });

  it("is revoked when revokedAt is set, even before expiry", () => {
    expect(
      sessionStatus(
        { expiresAt: "2026-01-01T18:00:00Z", revokedAt: "2026-01-01T11:00:00Z" },
        now,
      ),
    ).toBe("revoked");
  });

  it("is expired once expiresAt has passed", () => {
    expect(
      sessionStatus({ expiresAt: "2026-01-01T06:00:00Z", revokedAt: null }, now),
    ).toBe("expired");
  });

  it("treats an exact-boundary expiry as expired", () => {
    expect(sessionStatus({ expiresAt: now.toISOString(), revokedAt: null }, now)).toBe("expired");
  });
});

describe("credential types", () => {
  it("recognises exactly the known credential types", () => {
    for (const type of EMPLOYEE_CREDENTIAL_TYPES) {
      expect(isEmployeeCredentialType(type)).toBe(true);
    }
    expect(isEmployeeCredentialType("fingerprint")).toBe(false);
    expect(isEmployeeCredentialType("")).toBe(false);
  });

  it("only pin is issuable in Wave 1", () => {
    expect(isIssuableCredentialType("pin")).toBe(true);
    expect(isIssuableCredentialType("password")).toBe(false);
    expect(isIssuableCredentialType("webauthn")).toBe(false);
  });
});

describe("lockoutStatus", () => {
  const now = new Date("2026-01-01T12:00:00Z");

  function failuresAt(...minutesAgo: number[]): LoginAttemptEvent[] {
    // Most recent first, matching checkLoginLockout's ORDER BY id DESC.
    return minutesAgo
      .map((m) => ({ action: "employee.login_failed", createdAt: new Date(now.getTime() - m * 60_000) }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  it("is not locked with fewer than the threshold of failed attempts", () => {
    const events = failuresAt(...Array.from({ length: LOGIN_LOCKOUT_THRESHOLD - 1 }, (_, i) => i));
    const status = lockoutStatus(events, now);
    expect(status.locked).toBe(false);
    expect(status.failedCount).toBe(LOGIN_LOCKOUT_THRESHOLD - 1);
    expect(status.lockedUntil).toBeNull();
  });

  it("locks once the threshold of failed attempts is reached, all within the window", () => {
    const events = failuresAt(...Array.from({ length: LOGIN_LOCKOUT_THRESHOLD }, (_, i) => i));
    const status = lockoutStatus(events, now);
    expect(status.locked).toBe(true);
    expect(status.failedCount).toBe(LOGIN_LOCKOUT_THRESHOLD);
    expect(status.lockedUntil).toBe(
      new Date(now.getTime() + LOGIN_LOCKOUT_WINDOW_MINUTES * 60_000).toISOString(),
    );
  });

  it("is no longer locked once the window has passed since the most recent failure", () => {
    const events = failuresAt(
      ...Array.from({ length: LOGIN_LOCKOUT_THRESHOLD }, (_, i) => LOGIN_LOCKOUT_WINDOW_MINUTES + 1 + i),
    );
    const status = lockoutStatus(events, now);
    expect(status.locked).toBe(false);
    expect(status.lockedUntil).toBeNull();
  });

  it("breaks the streak on a successful login, even with older failures behind it", () => {
    const events: LoginAttemptEvent[] = [
      { action: "employee.session_created", createdAt: new Date(now.getTime() - 1 * 60_000) },
      ...failuresAt(...Array.from({ length: LOGIN_LOCKOUT_THRESHOLD + 2 }, (_, i) => 2 + i)),
    ];
    const status = lockoutStatus(events, now);
    expect(status.locked).toBe(false);
    expect(status.failedCount).toBe(0);
  });

  it("breaks the streak on a manual admin clear", () => {
    const events: LoginAttemptEvent[] = [
      { action: "employee.login_unlocked", createdAt: new Date(now.getTime() - 1 * 60_000) },
      ...failuresAt(...Array.from({ length: LOGIN_LOCKOUT_THRESHOLD + 2 }, (_, i) => 2 + i)),
    ];
    const status = lockoutStatus(events, now);
    expect(status.locked).toBe(false);
    expect(status.failedCount).toBe(0);
  });

  it("is not locked with no events at all", () => {
    expect(lockoutStatus([], now)).toEqual({ locked: false, failedCount: 0, lockedUntil: null });
  });
});
