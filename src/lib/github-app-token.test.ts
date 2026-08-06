import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  isGithubAppConfigured,
  mintPackageReadToken,
} from "./github-app-token";

vi.mock("jose", () => {
  const SignJWT = class {
    constructor() {}
    setProtectedHeader() {
      return this;
    }
    setIssuedAt() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    setIssuer() {
      return this;
    }
    async sign() {
      return "mocked-jwt";
    }
  };
  return {
    importPKCS8: vi.fn().mockResolvedValue("mocked-key"),
    SignJWT,
  };
});

describe("github-app-token", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    global.fetch = vi.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("isGithubAppConfigured", () => {
    it("returns false if config is missing", () => {
      delete process.env.GHCR_APP_ID;
      expect(isGithubAppConfigured()).toBe(false);
    });

    it("returns true if config is present", () => {
      process.env.GHCR_APP_ID = "123";
      process.env.GHCR_APP_INSTALLATION_ID = "456";
      process.env.GHCR_APP_PRIVATE_KEY = "test-key";
      expect(isGithubAppConfigured()).toBe(true);
    });
  });

  describe("mintPackageReadToken", () => {
    beforeEach(() => {
      process.env.GHCR_APP_ID = "123";
      process.env.GHCR_APP_INSTALLATION_ID = "456";
      process.env.GHCR_APP_PRIVATE_KEY = "test-key";
    });

    it("returns null if not configured", async () => {
      delete process.env.GHCR_APP_ID;
      expect(await mintPackageReadToken()).toBeNull();
    });

    it("returns token on successful fetch", async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          token: "ghs_12345",
          expires_at: "2023-10-01T12:00:00Z",
        }),
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      const result = await mintPackageReadToken();
      expect(result).toEqual({
        token: "ghs_12345",
        expiresAt: "2023-10-01T12:00:00Z",
      });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.github.com/app/installations/456/access_tokens",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer mocked-jwt",
          }),
        }),
      );
    });

    it("returns null on non-200 response", async () => {
      const mockResponse = {
        ok: false,
        status: 403,
      };
      (global.fetch as any).mockResolvedValue(mockResponse);

      const result = await mintPackageReadToken();
      expect(result).toBeNull();
    });

    it("returns null on fetch network error", async () => {
      (global.fetch as any).mockRejectedValue(new Error("Network Error"));

      const result = await mintPackageReadToken();
      expect(result).toBeNull();
    });

    it("returns null on JWT sign error", async () => {
      const jose = await import("jose");
      // override the mock class for this test
      jose.SignJWT.prototype.sign = vi
        .fn()
        .mockRejectedValue(new Error("Sign Error"));

      const result = await mintPackageReadToken();
      expect(result).toBeNull();
    });
  });
});
