import { describe, expect, it } from "vitest";
import { PAIRING_CODE_ALPHABET } from "./code-alphabet";
import {
  SYNC_TOKEN_PREFIX,
  generateSyncToken,
  isLegacySyncToken,
  normalizeSyncToken,
  parseSyncToken,
} from "./sync-token";

/** A stable token to mutate in the rejection cases, rather than a fresh random one. */
const VALID = generateSyncToken();

/** Swaps one body character for a different one from the alphabet. */
function corrupt(token: string, index: number): string {
  const bare = normalizeSyncToken(token);
  const at = SYNC_TOKEN_PREFIX.length + index;
  const replacement = PAIRING_CODE_ALPHABET[(PAIRING_CODE_ALPHABET.indexOf(bare[at]) + 1) % 32];
  return bare.slice(0, at) + replacement + bare.slice(at + 1);
}

describe("generateSyncToken", () => {
  it("produces the canonical grouped form: prefix, eight 4-char groups, 2-char checksum", () => {
    expect(VALID).toMatch(/^POS1(-[A-Z2-9]{4}){8}-[A-Z2-9]{2}$/);
  });

  it("never emits the look-alike characters the alphabet excludes", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateSyncToken().slice(SYNC_TOKEN_PREFIX.length)).not.toMatch(/[O0I1]/);
    }
  });

  it("does not repeat itself", () => {
    const tokens = new Set(Array.from({ length: 50 }, generateSyncToken));
    expect(tokens.size).toBe(50);
  });

  it("round-trips through parseSyncToken unchanged", () => {
    expect(parseSyncToken(VALID)).toEqual({ ok: true, canonical: VALID });
  });
});

describe("normalizeSyncToken", () => {
  it("folds Persian and Arabic-Indic digits to ASCII", () => {
    expect(normalizeSyncToken("POS۱-ABCD")).toBe("POS1ABCD");
    expect(normalizeSyncToken("POS١-ABCD")).toBe("POS1ABCD");
  });

  it("uppercases and strips hyphens, spaces, and newlines", () => {
    expect(normalizeSyncToken(" pos1-abcd\tefgh\n")).toBe("POS1ABCDEFGH");
  });
});

describe("parseSyncToken", () => {
  it("accepts a token typed in lowercase, unhyphenated, with Persian digits", () => {
    const mangled = ` ${normalizeSyncToken(VALID).toLowerCase().replace("pos1", "pos۱")} `;
    expect(parseSyncToken(mangled)).toEqual({ ok: true, canonical: VALID });
  });

  it("accepts arbitrary regrouping and re-canonicalizes it", () => {
    const bare = normalizeSyncToken(VALID);
    const regrouped = `${bare.slice(0, 10)}-${bare.slice(10, 20)}-${bare.slice(20)}`;
    expect(parseSyncToken(regrouped)).toEqual({ ok: true, canonical: VALID });
  });

  it("rejects a missing or wrong version prefix", () => {
    expect(parseSyncToken(normalizeSyncToken(VALID).slice(4))).toEqual({ ok: false, error: "bad_prefix" });
    expect(parseSyncToken(`POS2${normalizeSyncToken(VALID).slice(4)}`)).toEqual({ ok: false, error: "bad_prefix" });
  });

  it("rejects a truncated paste", () => {
    expect(parseSyncToken(normalizeSyncToken(VALID).slice(0, -3))).toEqual({ ok: false, error: "bad_length" });
  });

  it("rejects a token with extra characters appended", () => {
    expect(parseSyncToken(`${VALID}XY`)).toEqual({ ok: false, error: "bad_length" });
  });

  it("rejects the look-alike characters the alphabet excludes", () => {
    const bare = normalizeSyncToken(VALID);
    expect(parseSyncToken(`${bare.slice(0, 6)}0${bare.slice(7)}`)).toEqual({ ok: false, error: "bad_charset" });
    expect(parseSyncToken(`${bare.slice(0, 6)}I${bare.slice(7)}`)).toEqual({ ok: false, error: "bad_charset" });
  });

  it("rejects every single-character substitution in the payload", () => {
    for (let i = 0; i < 32; i += 1) {
      expect(parseSyncToken(corrupt(VALID, i))).toEqual({ ok: false, error: "bad_checksum" });
    }
  });

  it("rejects a corrupted checksum", () => {
    expect(parseSyncToken(corrupt(VALID, 32))).toEqual({ ok: false, error: "bad_checksum" });
    expect(parseSyncToken(corrupt(VALID, 33))).toEqual({ ok: false, error: "bad_checksum" });
  });

  it("rejects an adjacent transposition inside the payload", () => {
    const bare = normalizeSyncToken(VALID);
    const payloadEnd = SYNC_TOKEN_PREFIX.length + 32;
    for (let i = SYNC_TOKEN_PREFIX.length; i < payloadEnd - 1; i += 1) {
      if (bare[i] === bare[i + 1]) continue;
      const swapped = bare.slice(0, i) + bare[i + 1] + bare[i] + bare.slice(i + 2);
      expect(parseSyncToken(swapped)).toEqual({ ok: false, error: "bad_checksum" });
    }
  });

  it("rejects a legacy hex token — it is valid, but not in this format", () => {
    expect(parseSyncToken("a".repeat(64))).toEqual({ ok: false, error: "bad_prefix" });
  });
});

describe("isLegacySyncToken", () => {
  it("accepts the openssl rand -hex 32 secrets already in the field", () => {
    expect(isLegacySyncToken("0123456789abcdef".repeat(4))).toBe(true);
    expect(isLegacySyncToken("0123456789ABCDEF".repeat(4))).toBe(true);
    expect(isLegacySyncToken(` ${"a".repeat(32)} `)).toBe(true);
  });

  it("rejects anything shorter than 32 hex characters, or not hex at all", () => {
    expect(isLegacySyncToken("a".repeat(31))).toBe(false);
    expect(isLegacySyncToken("existing-token-1234")).toBe(false);
    expect(isLegacySyncToken(VALID)).toBe(false);
  });
});
