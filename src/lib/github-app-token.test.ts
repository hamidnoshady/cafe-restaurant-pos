import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isGithubAppConfigured } from "./github-app-token";

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
