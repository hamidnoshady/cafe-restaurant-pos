import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mintPackageReadToken } from "./github-app-token";
import * as jose from "jose";

vi.mock("jose", async () => {
  const actual = await vi.importActual("jose");
  return {
    ...actual,
    importPKCS8: vi.fn(),
  };
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
