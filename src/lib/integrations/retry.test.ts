import { describe, expect, it } from "vitest";
import { backoffDelayMs, isDeadAfterAttempts, OUTBOX_MAX_ATTEMPTS } from "./retry";

describe("backoffDelayMs", () => {
  it("doubles per attempt", () => {
    expect(backoffDelayMs(0, 5000, 60000)).toBe(5000);
    expect(backoffDelayMs(1, 5000, 60000)).toBe(10000);
    expect(backoffDelayMs(2, 5000, 60000)).toBe(20000);
    expect(backoffDelayMs(3, 5000, 60000)).toBe(40000);
  });

  it("caps at the maximum", () => {
    expect(backoffDelayMs(10, 5000, 60000)).toBe(60000);
    expect(backoffDelayMs(100, 5000, 60000)).toBe(60000);
  });

  it("treats negative attempts as zero", () => {
    expect(backoffDelayMs(-1, 5000, 60000)).toBe(5000);
  });
});

describe("isDeadAfterAttempts", () => {
  it("dead-letters only at or past the max", () => {
    expect(isDeadAfterAttempts(0)).toBe(false);
    expect(isDeadAfterAttempts(OUTBOX_MAX_ATTEMPTS - 1)).toBe(false);
    expect(isDeadAfterAttempts(OUTBOX_MAX_ATTEMPTS)).toBe(true);
    expect(isDeadAfterAttempts(OUTBOX_MAX_ATTEMPTS + 3)).toBe(true);
  });
});
