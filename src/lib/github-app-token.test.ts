import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { isGithubAppConfigured, mintPackageReadToken } from "./github-app-token";
import * as jose from "jose";

vi.mock("jose", async () => {
  const actual = await vi.importActual("jose");
  return {
    ...actual,
    importPKCS8: vi.fn(),
  };
});

describe("isGithubAppConfigured", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns true when all required env vars are set", () => {
    process.env.GHCR_APP_ID = "12345";
    process.env.GHCR_APP_INSTALLATION_ID = "67890";
    process.env.GHCR_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";

    expect(isGithubAppConfigured()).toBe(true);
  });

  it("returns false when GHCR_APP_ID is missing", () => {
    delete process.env.GHCR_APP_ID;
    process.env.GHCR_APP_INSTALLATION_ID = "67890";
    process.env.GHCR_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";

    expect(isGithubAppConfigured()).toBe(false);
  });

  it("returns false when GHCR_APP_INSTALLATION_ID is missing", () => {
    process.env.GHCR_APP_ID = "12345";
    delete process.env.GHCR_APP_INSTALLATION_ID;
    process.env.GHCR_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";

    expect(isGithubAppConfigured()).toBe(false);
  });

  it("returns false when GHCR_APP_PRIVATE_KEY is missing", () => {
    process.env.GHCR_APP_ID = "12345";
    process.env.GHCR_APP_INSTALLATION_ID = "67890";
    delete process.env.GHCR_APP_PRIVATE_KEY;

    expect(isGithubAppConfigured()).toBe(false);
  });

  it("returns false when all required env vars are missing", () => {
    delete process.env.GHCR_APP_ID;
    delete process.env.GHCR_APP_INSTALLATION_ID;
    delete process.env.GHCR_APP_PRIVATE_KEY;

    expect(isGithubAppConfigured()).toBe(false);
  });

  it("returns false when env vars are empty strings", () => {
    process.env.GHCR_APP_ID = "   ";
    process.env.GHCR_APP_INSTALLATION_ID = "";
    process.env.GHCR_APP_PRIVATE_KEY = " \n ";

    expect(isGithubAppConfigured()).toBe(false);
  });
});

describe("mintPackageReadToken", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("returns null if mintAppJwt throws an error", async () => {
    process.env.GHCR_APP_ID = "test-app-id";
    process.env.GHCR_APP_INSTALLATION_ID = "test-installation-id";
    process.env.GHCR_APP_PRIVATE_KEY = "test-private-key";

    vi.mocked(jose.importPKCS8).mockRejectedValue(new Error("mock error in importPKCS8"));

    const result = await mintPackageReadToken();

    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledWith("github-app-token: failed to sign app JWT:", expect.any(Error));
  });
});