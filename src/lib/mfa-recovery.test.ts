import { describe, it, expect } from "vitest";
import {
  generateRecoveryCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "./mfa-recovery";
import { PAIRING_CODE_ALPHABET } from "./code-alphabet";

describe("recovery code generation", () => {
  it("issues ten codes, per the phase spec", () => {
    expect(generateRecoveryCodes()).toHaveLength(RECOVERY_CODE_COUNT);
  });

  it("draws only from the ambiguity-free alphabet — these are read off paper", () => {
    for (const code of generateRecoveryCodes()) {
      expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      for (const ch of code.replace("-", "")) {
        expect(PAIRING_CODE_ALPHABET).toContain(ch);
      }
      // The whole point of Phase 23's alphabet: no O/0 and no I/1 confusion.
      expect(code).not.toMatch(/[O0I1]/);
    }
  });

  it("does not repeat itself", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(200);
  });
});

describe("normalizeRecoveryCode", () => {
  const canonical = "ABCDE-FGHJK";

  it("accepts the code exactly as printed", () => {
    expect(normalizeRecoveryCode(canonical)).toBe(canonical);
  });

  it("accepts it without the hyphen, in lower case, with stray spaces", () => {
    expect(normalizeRecoveryCode("abcdefghjk")).toBe(canonical);
    expect(normalizeRecoveryCode("  ABCDE FGHJK ")).toBe(canonical);
    expect(normalizeRecoveryCode("abcde—fghjk")).toBe(canonical);
  });

  it("folds Persian digits — a Persian keyboard produces them by default", () => {
    // ۲۳۴۵۶-۷۸۹۲۳ is the same code as 23456-78923.
    expect(normalizeRecoveryCode("۲۳۴۵۶-۷۸۹۲۳")).toBe("23456-78923");
  });

  it("returns something un-matchable rather than guessing at a wrong-length code", () => {
    // Short input must not be silently padded into a valid-looking code; the
    // caller compares it against bcrypt hashes of full-length codes and gets
    // no match, which is the correct outcome.
    expect(normalizeRecoveryCode("ABC")).toBe("ABC");
    expect(normalizeRecoveryCode("")).toBe("");
    expect(normalizeRecoveryCode("!!!!")).toBe("");
  });
});
