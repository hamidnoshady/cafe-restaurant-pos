import { describe, expect, it } from "vitest";
import { classifyConnectionCode, normalizeServerAddress } from "./connection-code";
import { generatePairingCode } from "./pairing-codes";
import { generateSyncToken } from "./sync-token";
import { createApiKey } from "./api-auth";

describe("classifyConnectionCode", () => {
  it("accepts a freshly generated pairing code", () => {
    for (let i = 0; i < 25; i += 1) {
      expect(classifyConnectionCode(generatePairingCode())).toBe("pairing_code");
    }
  });

  it("accepts a pairing code however it was typed: no hyphens, lowercase, spaced, Persian digits", () => {
    const code = "ABCD-EF23-GHJK";
    expect(classifyConnectionCode("ABCDEF23GHJK")).toBe("pairing_code");
    expect(classifyConnectionCode(code.toLowerCase())).toBe("pairing_code");
    expect(classifyConnectionCode(" ABCD EF23 GHJK ")).toBe("pairing_code");
    expect(classifyConnectionCode("ABCD-EF۲۳-GHJK")).toBe("pairing_code");
  });

  it("calls out the look-alike characters rather than passing them through", () => {
    // The alphabet issues none of 0, 1, O or I, so any of them is a typo that
    // could only ever come back from the server as "code not found". Naming
    // the actual problem is more useful than that.
    for (const typo of ["0BCD-EF23-GHJK", "1BCD-EF23-GHJK", "OBCD-EF23-GHJK", "IBCD-EF23-GHJK"]) {
      expect(classifyConnectionCode(typo)).toBe("bad_charset");
    }
  });

  it("names a server-sync token for what it is — the mistake this whole check exists for", () => {
    expect(classifyConnectionCode(generateSyncToken())).toBe("sync_token");
    // Recognised before length or charset is judged, and regardless of how the
    // owner pasted it, because "this is the wrong credential" is the useful
    // thing to say about any of these.
    expect(classifyConnectionCode("pos1-abcd-efgh")).toBe("sync_token");
    expect(classifyConnectionCode("  POS1ABCD  ")).toBe("sync_token");
  });

  it("names a public API key too", () => {
    expect(classifyConnectionCode(createApiKey())).toBe("api_key");
    expect(classifyConnectionCode("posk_live_anything")).toBe("api_key");
  });

  it("reports an empty box as empty rather than as a malformed code", () => {
    expect(classifyConnectionCode("")).toBe("empty");
    expect(classifyConnectionCode("   ")).toBe("empty");
  });

  it("distinguishes a truncated paste from a mistyped one", () => {
    expect(classifyConnectionCode("ABCD-EF23")).toBe("bad_length");
    expect(classifyConnectionCode("ABCD-EF23-GHJK-LMNP")).toBe("bad_length");
    // Separators and punctuation are stripped before the count, so this is
    // eleven characters, not twelve-with-a-symbol.
    expect(classifyConnectionCode("ABCD-EF23-GH!K")).toBe("bad_length");
    // Twelve characters, one of which is never issued.
    expect(classifyConnectionCode("ABCD-EF23-GHJI")).toBe("bad_charset");
  });
});

describe("normalizeServerAddress", () => {
  it("assumes https for a bare hostname rather than downgrading to http", () => {
    // The redeem response carries credential hashes for a whole business.
    expect(normalizeServerAddress("mycafe.example.com")).toEqual({
      ok: true,
      url: "https://mycafe.example.com",
    });
  });

  it("keeps an explicitly stated http, which a LAN pairing genuinely needs", () => {
    expect(normalizeServerAddress("http://192.168.1.20:3000")).toEqual({
      ok: true,
      url: "http://192.168.1.20:3000",
    });
  });

  it("drops the path, query and fragment — copying a logged-in address bar yields /dashboard", () => {
    expect(normalizeServerAddress("https://biz1.example.com/dashboard/settings?tab=x#y")).toEqual({
      ok: true,
      url: "https://biz1.example.com",
    });
  });

  it("keeps a non-default port, which is part of the address", () => {
    expect(normalizeServerAddress("https://biz1.example.com:8443/")).toEqual({
      ok: true,
      url: "https://biz1.example.com:8443",
    });
  });

  it("folds Persian digits, which a Persian keyboard produces by default", () => {
    expect(normalizeServerAddress("http://192.168.1.20:۳۰۰۰")).toEqual({
      ok: true,
      url: "http://192.168.1.20:3000",
    });
  });

  it("normalises case and surrounding whitespace", () => {
    expect(normalizeServerAddress("  HTTPS://Biz1.Example.COM/  ")).toEqual({
      ok: true,
      url: "https://biz1.example.com",
    });
  });

  it("reports an empty address separately from an invalid one", () => {
    expect(normalizeServerAddress("")).toEqual({ ok: false, error: "missing_address" });
    expect(normalizeServerAddress("   ")).toEqual({ ok: false, error: "missing_address" });
  });

  it("rejects what is not an address", () => {
    expect(normalizeServerAddress("not a host")).toEqual({ ok: false, error: "invalid_url" });
    expect(normalizeServerAddress("ftp://example.com")).toEqual({ ok: false, error: "invalid_url" });
    // Credentials in the URL are never something this flow wants to carry.
    expect(normalizeServerAddress("https://user:pass@example.com")).toEqual({ ok: false, error: "invalid_url" });
  });
});
