import { describe, it, expect } from "vitest";
import { clientIpFrom } from "./rate-limit";

describe("rate-limit clientIpFrom", () => {
  it("resolves IP using trusted hops", () => {
    const headers = new Headers();
    headers.set("x-forwarded-for", "1.1.1.1, 2.2.2.2, 3.3.3.3");
    
    // 0 hops -> trust nothing, use the rightmost
    expect(clientIpFrom(headers, 0)).toBe("3.3.3.3");

    // 1 hop -> trust the last proxy, use the second to last
    expect(clientIpFrom(headers, 1)).toBe("2.2.2.2");

    // > available hops -> clamp to 0
    expect(clientIpFrom(headers, 5)).toBe("1.1.1.1");
  });

  it("falls back to x-real-ip if no XFF", () => {
    const headers = new Headers();
    headers.set("x-real-ip", "10.0.0.1");
    expect(clientIpFrom(headers, 1)).toBe("10.0.0.1");
  });

  it("returns unknown if neither is present", () => {
    const headers = new Headers();
    expect(clientIpFrom(headers, 1)).toBe("unknown");
  });
});
