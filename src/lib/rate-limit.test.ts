import { describe, expect, it } from "vitest";
import { checkRateLimit, hashKey, sweepExpired, type RateLimitEntry } from "./rate-limit";

describe("checkRateLimit", () => {
  it("allows requests under the limit and counts them", () => {
    const store = new Map<string, RateLimitEntry>();
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(store, "a", 5, 60_000, 1_000).allowed).toBe(true);
    }
  });

  it("blocks once the limit is reached within the window", () => {
    const store = new Map<string, RateLimitEntry>();
    for (let i = 0; i < 3; i++) checkRateLimit(store, "a", 3, 60_000, 1_000);
    const result = checkRateLimit(store, "a", 3, 60_000, 1_500);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(60_000 - 500);
  });

  it("resets once the window has elapsed", () => {
    const store = new Map<string, RateLimitEntry>();
    for (let i = 0; i < 3; i++) checkRateLimit(store, "a", 3, 60_000, 1_000);
    expect(checkRateLimit(store, "a", 3, 60_000, 1_000 + 60_000).allowed).toBe(true);
  });

  it("keys are independent — one business's traffic can't exhaust another's", () => {
    const store = new Map<string, RateLimitEntry>();
    for (let i = 0; i < 3; i++) checkRateLimit(store, "biz:a", 3, 60_000, 1_000);
    expect(checkRateLimit(store, "biz:a", 3, 60_000, 1_000).allowed).toBe(false);
    expect(checkRateLimit(store, "biz:b", 3, 60_000, 1_000).allowed).toBe(true);
  });

  it("retryAfterMs counts down to zero at the window boundary", () => {
    const store = new Map<string, RateLimitEntry>();
    checkRateLimit(store, "a", 1, 10_000, 0);
    const blocked = checkRateLimit(store, "a", 1, 10_000, 9_999);
    expect(blocked.retryAfterMs).toBe(1);
  });
});

describe("sweepExpired", () => {
  it("drops only entries older than staleAfterMs", () => {
    const store = new Map<string, RateLimitEntry>([
      ["old", { count: 1, windowStart: 0 }],
      ["fresh", { count: 1, windowStart: 9_000 }],
    ]);
    sweepExpired(store, 10_000, 5_000);
    expect(store.has("old")).toBe(false);
    expect(store.has("fresh")).toBe(true);
  });

  it("leaves an empty store alone", () => {
    const store = new Map<string, RateLimitEntry>();
    expect(() => sweepExpired(store, Date.now(), 5_000)).not.toThrow();
    expect(store.size).toBe(0);
  });
});

describe("hashKey", () => {
  it("is deterministic", () => {
    expect(hashKey("same-token")).toBe(hashKey("same-token"));
  });

  it("differs (in practice) for different inputs", () => {
    expect(hashKey("token-a")).not.toBe(hashKey("token-b"));
  });

  it("never throws on an empty string", () => {
    expect(() => hashKey("")).not.toThrow();
  });
});
