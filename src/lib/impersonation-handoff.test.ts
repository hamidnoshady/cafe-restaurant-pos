import { describe, expect, it } from "vitest";
import {
  generateImpersonationHandoffToken,
  hashImpersonationHandoffToken,
  IMPERSONATION_HANDOFF_PREFIX,
} from "./impersonation-handoff";

describe("impersonation handoff tokens", () => {
  it("returns a prefixed token and its hash, never storing the plaintext", () => {
    const { token, tokenHash } = generateImpersonationHandoffToken();
    expect(token.startsWith(IMPERSONATION_HANDOFF_PREFIX)).toBe(true);
    expect(tokenHash).toBe(hashImpersonationHandoffToken(token));
    expect(tokenHash).not.toContain(token.slice(IMPERSONATION_HANDOFF_PREFIX.length));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates a distinct token every time", () => {
    const tokens = new Set(
      Array.from({ length: 50 }, () => generateImpersonationHandoffToken().token),
    );
    expect(tokens.size).toBe(50);
  });

  it("hashes deterministically so a presented token can be looked up", () => {
    const { token } = generateImpersonationHandoffToken();
    expect(hashImpersonationHandoffToken(token)).toBe(hashImpersonationHandoffToken(token));
  });
});
