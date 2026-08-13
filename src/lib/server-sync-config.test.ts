import { describe, expect, it } from "vitest";
import { resolveConfigUpdate, syncTokenFormat } from "./server-sync-config";
import { generateSyncToken, normalizeSyncToken } from "./sync-token";

const TOKEN = generateSyncToken();
const ROTATED = generateSyncToken();
/** What every install paired before Phase 23 Wave 1 holds. */
const LEGACY_HEX = "a".repeat(64);

const EXISTING = { remoteUrl: "https://pos.eshobe.com", token: TOKEN, enabled: true, batchSize: 100 };

describe("resolveConfigUpdate", () => {
  it("accepts a full new config, including a fresh token", () => {
    const result = resolveConfigUpdate(null, {
      remoteUrl: "https://pos.eshobe.com",
      token: TOKEN,
      enabled: true,
      batchSize: 50,
    });
    expect(result).toEqual({
      ok: true,
      config: { remoteUrl: "https://pos.eshobe.com", token: TOKEN, enabled: true, batchSize: 50 },
    });
  });

  it("keeps the existing token when the owner doesn't type a new one", () => {
    const result = resolveConfigUpdate(EXISTING, { remoteUrl: "https://pos.eshobe.com", enabled: true, batchSize: 100 });
    expect(result).toEqual({ ok: true, config: EXISTING });
  });

  it("replaces the token when the owner types a new one", () => {
    const result = resolveConfigUpdate(EXISTING, {
      remoteUrl: "https://pos.eshobe.com",
      token: ROTATED,
      enabled: true,
      batchSize: 100,
    });
    expect(result).toEqual({
      ok: true,
      config: { remoteUrl: "https://pos.eshobe.com", token: ROTATED, enabled: true, batchSize: 100 },
    });
  });

  it("stores the canonical form of a token typed without hyphens or in lowercase", () => {
    const result = resolveConfigUpdate(null, {
      remoteUrl: "https://pos.eshobe.com",
      token: `  ${normalizeSyncToken(TOKEN).toLowerCase()}  `,
      enabled: true,
    });
    // Both sides hash the stored string verbatim (server-sync.ts), so the
    // stored value has to be canonical or a correctly-typed token would 401.
    expect(result.ok && result.config.token).toBe(TOKEN);
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
    expect(result).toEqual({ ok: true, config: { remoteUrl: "", token: TOKEN, enabled: false, batchSize: 100 } });
  });

  it("rejects a malformed remote URL", () => {
    expect(resolveConfigUpdate(null, { remoteUrl: "not-a-url", token: TOKEN, enabled: true })).toEqual({
      ok: false,
      error: "invalid_url",
    });
  });

  it("reports why a newly typed token is malformed, rather than only that it is short", () => {
    const bare = normalizeSyncToken(TOKEN);
    const at = (body: string) => resolveConfigUpdate(EXISTING, { remoteUrl: "https://pos.eshobe.com", token: body });
    expect(at("short")).toEqual({ ok: false, error: "bad_prefix" });
    expect(at(bare.slice(0, -2))).toEqual({ ok: false, error: "bad_length" });
    expect(at(`${bare.slice(0, 6)}0${bare.slice(7)}`)).toEqual({ ok: false, error: "bad_charset" });
    expect(at(`${bare.slice(0, -1)}${bare.at(-1) === "A" ? "B" : "A"}`)).toEqual({ ok: false, error: "bad_checksum" });
  });

  it("still accepts a legacy hex token, so paired installs survive the upgrade", () => {
    const result = resolveConfigUpdate(null, {
      remoteUrl: "https://pos.eshobe.com",
      token: LEGACY_HEX,
      enabled: true,
    });
    expect(result.ok && result.config.token).toBe(LEGACY_HEX);
  });

  it("never validates the existing token, only a newly typed one", () => {
    const legacyConfig = { remoteUrl: "https://pos.eshobe.com", token: LEGACY_HEX, enabled: true, batchSize: 100 };
    expect(resolveConfigUpdate(legacyConfig, { remoteUrl: "https://pos.eshobe.com", enabled: true })).toEqual({
      ok: true,
      config: legacyConfig,
    });
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

describe("syncTokenFormat", () => {
  it("distinguishes a current token from a legacy one, and reports none at all", () => {
    expect(syncTokenFormat(TOKEN)).toBe("current");
    expect(syncTokenFormat(LEGACY_HEX)).toBe("legacy");
    expect(syncTokenFormat("")).toBe(null);
  });
});
