import { describe, expect, it } from "vitest";
import { retryAfterMs } from "./login-helpers";

/**
 * The staff picker's roster read has a per-IP ceiling (ROSTER_IP_LIMIT in
 * src/middleware.ts) and answers 429 with a `Retry-After` when it is spent;
 * this turns that header into the wait the login screen owes the caller.
 */
describe("retryAfterMs", () => {
  it("honours the seconds the server named", () => {
    expect(retryAfterMs("27")).toBe(27_000);
    expect(retryAfterMs("1")).toBe(1_000);
  });

  it("falls back to a short wait on a header it cannot use — never 'do not retry'", () => {
    // The regression this guards: a response the screen cannot interpret must
    // not park a till on an error that was always going to clear by itself.
    expect(retryAfterMs(null)).toBe(3_000);
    expect(retryAfterMs("soon")).toBe(3_000);
    expect(retryAfterMs("0")).toBe(3_000);
    expect(retryAfterMs("-5")).toBe(3_000);
  });

  it("is bounded at both ends", () => {
    // A sub-second window is not worth polling faster than, and a bogus huge
    // one must not leave a cashier staring at a screen that will not refresh.
    expect(retryAfterMs("0.25")).toBe(1_000);
    expect(retryAfterMs("900")).toBe(30_000);
  });
});
