import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function freshGetJwtSecret() {
  vi.resetModules();
  return (await import("./jwt-secret")).getJwtSecret;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getJwtSecret", () => {
  it("encodes a configured secret as-is outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("JWT_SECRET", "short");
    const getJwtSecret = await freshGetJwtSecret();
    expect(getJwtSecret("sessions")).toEqual(new TextEncoder().encode("short"));
  });

  it("accepts a long-enough secret in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JWT_SECRET", "a".repeat(32));
    const getJwtSecret = await freshGetJwtSecret();
    expect(getJwtSecret("sessions")).toEqual(new TextEncoder().encode("a".repeat(32)));
  });

  it("throws in production when the secret is shorter than 32 characters", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JWT_SECRET", "too-short");
    const getJwtSecret = await freshGetJwtSecret();
    expect(() => getJwtSecret("sessions")).toThrow(/only 9 characters/);
  });

  it("does not enforce a minimum length outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("JWT_SECRET", "x");
    const getJwtSecret = await freshGetJwtSecret();
    expect(() => getJwtSecret("sessions")).not.toThrow();
  });

  it("throws when JWT_SECRET is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JWT_SECRET", "");
    const getJwtSecret = await freshGetJwtSecret();
    expect(() => getJwtSecret("sessions")).toThrow(/must be set/);
  });

  /**
   * `context` was an unused parameter for a while — every call site labelled
   * what it was signing and the message discarded it, so a developer hitting
   * this got no clue which key failed or how to make one.
   */
  it("names what was being signed, and how to produce a secret", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("JWT_SECRET", "");
    const getJwtSecret = await freshGetJwtSecret();
    expect(() => getJwtSecret("platform sessions")).toThrow(/platform sessions/);
    expect(() => getJwtSecret("platform sessions")).toThrow(/openssl rand -hex 32/);
  });

  it("names what was being signed when a production secret is too short", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JWT_SECRET", "too-short");
    const getJwtSecret = await freshGetJwtSecret();
    expect(() => getJwtSecret("webauthn ceremony challenges")).toThrow(
      /webauthn ceremony challenges/,
    );
  });

  it("throws when JWT_SECRET is still the placeholder", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JWT_SECRET", "change-me-in-production");
    const getJwtSecret = await freshGetJwtSecret();
    expect(() => getJwtSecret("sessions")).toThrow(/must be set/);
  });
});
