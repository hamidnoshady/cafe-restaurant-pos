import { describe, expect, it } from "vitest";
import {
  EMPLOYEE_CREDENTIAL_TYPES,
  EMPLOYEE_SESSION_TTL_HOURS,
  generateSessionToken,
  hashSessionToken,
  isEmployeeCredentialType,
  isIssuableCredentialType,
  sessionExpiry,
  sessionStatus,
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
