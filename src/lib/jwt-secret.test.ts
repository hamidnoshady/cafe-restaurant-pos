import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { SignJWT, jwtVerify } from "jose";
import { getRealmSecret, getLegacySecret, verifyWithRealmSecret, __clearJwtCache } from "./jwt-secret";

describe("jwt-secret", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    __clearJwtCache();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("realm keys differ from each other and from the raw secret", async () => {
    process.env.JWT_SECRET = "0123456789abcdef0123456789abcdef";
    const tenant = await getRealmSecret("tenant");
    const platform = await getRealmSecret("platform");
    const raw = new TextEncoder().encode(process.env.JWT_SECRET);

    expect(tenant).not.toEqual(platform);
    expect(tenant).not.toEqual(raw);
    expect(platform).not.toEqual(raw);
  });

  it("a tenant-signed token with a rewritten realm claim fails platform verification", async () => {
    process.env.JWT_SECRET = "0123456789abcdef0123456789abcdef";
    const tenantKey = await getRealmSecret("tenant");
    const token = await new SignJWT({ realm: "platform" })
      .setProtectedHeader({ alg: "HS256" })
      .sign(tenantKey);

    await expect(verifyWithRealmSecret(token, "platform")).rejects.toThrow();
  });

  it("legacy fallback works and stops when disabled", async () => {
    process.env.JWT_SECRET = "0123456789abcdef0123456789abcdef";
    const rawKey = new TextEncoder().encode(process.env.JWT_SECRET);
    const token = await new SignJWT({ realm: "tenant" })
      .setProtectedHeader({ alg: "HS256" })
      .sign(rawKey);

    // Fallback is enabled by default
    const payload = await verifyWithRealmSecret(token, "tenant");
    expect(payload).not.toBeNull();
    expect((payload as any).realm).toBe("tenant");

    // Disable fallback
    process.env.JWT_LEGACY_VERIFY = "off";
    await expect(verifyWithRealmSecret(token, "tenant")).rejects.toThrow();
  });

  it("the < 32 chars production floor survives", async () => {
    (process.env as any).NODE_ENV = "production";
    process.env.JWT_SECRET = "short";
    await expect(getRealmSecret("tenant")).rejects.toThrow(/at least 32 are required/);
  });
});
