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

  it("throws in production when JWT_SECRET is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JWT_SECRET", "");
    const getJwtSecret = await freshGetJwtSecret();
    expect(() => getJwtSecret("sessions")).toThrow(/must be set/);
  });

  it("throws in production when JWT_SECRET is still the placeholder", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JWT_SECRET", "change-me-in-production");
    const getJwtSecret = await freshGetJwtSecret();
    expect(() => getJwtSecret("sessions")).toThrow(/must be set/);
  });

  it("falls back to a dev secret and warns once outside production when unset", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("JWT_SECRET", "");
    const getJwtSecret = await freshGetJwtSecret();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const first = getJwtSecret("sessions");
    const second = getJwtSecret("platform sessions");

    expect(first).toEqual(second);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/SECURITY WARNING/);
  });
});
