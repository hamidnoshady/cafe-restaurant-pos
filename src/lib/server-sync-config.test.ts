import { describe, expect, it } from "vitest";
import { resolveConfigUpdate } from "./server-sync-config";

const EXISTING = { remoteUrl: "https://pos.eshobe.com", token: "existing-token-1234", enabled: true, batchSize: 100 };

describe("resolveConfigUpdate", () => {
  it("accepts a full new config, including a fresh token", () => {
    const result = resolveConfigUpdate(null, {
      remoteUrl: "https://pos.eshobe.com",
      token: "a-brand-new-token-1234",
      enabled: true,
      batchSize: 50,
    });
    expect(result).toEqual({
      ok: true,
      config: { remoteUrl: "https://pos.eshobe.com", token: "a-brand-new-token-1234", enabled: true, batchSize: 50 },
    });
  });

  it("keeps the existing token when the owner doesn't type a new one", () => {
    const result = resolveConfigUpdate(EXISTING, { remoteUrl: "https://pos.eshobe.com", enabled: true, batchSize: 100 });
    expect(result).toEqual({ ok: true, config: EXISTING });
  });

  it("replaces the token when the owner types a new one", () => {
    const result = resolveConfigUpdate(EXISTING, {
      remoteUrl: "https://pos.eshobe.com",
      token: "rotated-token-5678",
      enabled: true,
      batchSize: 100,
    });
    expect(result).toEqual({
      ok: true,
      config: { remoteUrl: "https://pos.eshobe.com", token: "rotated-token-5678", enabled: true, batchSize: 100 },
    });
  });

  it("rejects enabling without a remote URL or a token to fall back on", () => {
    expect(resolveConfigUpdate(null, { enabled: true })).toEqual({ ok: false, error: "missing_fields" });
    expect(resolveConfigUpdate(null, { remoteUrl: "https://pos.eshobe.com", enabled: true })).toEqual({
      ok: false,
      error: "missing_fields",
    });
  });

  it("allows disabling with no remote URL or token at all", () => {
    const result = resolveConfigUpdate(EXISTING, { enabled: false });
    expect(result).toEqual({ ok: true, config: { remoteUrl: "", token: "existing-token-1234", enabled: false, batchSize: 100 } });
  });

  it("rejects a malformed remote URL", () => {
    expect(resolveConfigUpdate(null, { remoteUrl: "not-a-url", token: "a-token-1234567890", enabled: true })).toEqual({
      ok: false,
      error: "invalid_url",
    });
  });

  it("rejects a newly typed token that's too short", () => {
    expect(
      resolveConfigUpdate(EXISTING, { remoteUrl: "https://pos.eshobe.com", token: "short", enabled: true }),
    ).toEqual({ ok: false, error: "token_too_short" });
  });

  it("clamps batchSize into [1, 200] and defaults to 100 when absent", () => {
    function batchSizeOf(result: ReturnType<typeof resolveConfigUpdate>): number | undefined {
      return result.ok ? result.config.batchSize : undefined;
    }
    expect(batchSizeOf(resolveConfigUpdate(null, { enabled: false, batchSize: 9999 }))).toBe(200);
    expect(batchSizeOf(resolveConfigUpdate(null, { enabled: false, batchSize: 0 }))).toBe(1);
    expect(batchSizeOf(resolveConfigUpdate(null, { enabled: false }))).toBe(100);
  });
});
