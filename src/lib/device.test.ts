import { describe, expect, it } from "vitest";
import { generateDeviceToken, hashDeviceToken } from "./device";

describe("device tokens", () => {
  it("returns a prefixed token and its hash, never storing the plaintext", () => {
    const { token, tokenHash } = generateDeviceToken();
    expect(token.startsWith("posdev_")).toBe(true);
    expect(tokenHash).toBe(hashDeviceToken(token));
    expect(tokenHash).not.toContain(token.slice(8));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates a distinct token every time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateDeviceToken().token));
    expect(tokens.size).toBe(50);
  });

  it("hashes deterministically so a presented token can be looked up", () => {
    expect(hashDeviceToken("posdev_abc")).toBe(hashDeviceToken("posdev_abc"));
    expect(hashDeviceToken("posdev_abc")).not.toBe(hashDeviceToken("posdev_abd"));
  });
});
