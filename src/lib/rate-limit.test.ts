import { describe, it, expect } from "vitest";
import { clientIpFrom } from "./rate-limit";

describe("rate-limit clientIpFrom", () => {
  it("resolves IP using trusted hops when > 0", () => {
    const headers = new Headers();
    headers.set("x-forwarded-for", "1.1.1.1, 2.2.2.2, 3.3.3.3");
    
    // 1 hop -> trust the last proxy, use the second to last
    expect(clientIpFrom(headers, 1)).toBe("2.2.2.2");

    // > available hops -> clamp to 0
    expect(clientIpFrom(headers, 5)).toBe("1.1.1.1");
  });

  it("resolves IP right-to-left skipping private IPs when trustedHops = 0", () => {
    const headers = new Headers();

    // Public IP, then private proxies
    headers.set("x-forwarded-for", "1.1.1.1, 10.0.0.1, 192.168.1.1");
    expect(clientIpFrom(headers, 0)).toBe("1.1.1.1");

    // Spoofed public IP, real public IP, then private proxies
    headers.set("x-forwarded-for", "8.8.8.8, 1.1.1.1, 10.0.0.1");
    expect(clientIpFrom(headers, 0)).toBe("1.1.1.1");
  });

  it("returns the rightmost IP if all are private when trustedHops = 0", () => {
    const headers = new Headers();
    headers.set("x-forwarded-for", "10.0.0.2, 192.168.1.1");
    expect(clientIpFrom(headers, 0)).toBe("192.168.1.1");
  });

  it("prioritizes x-real-ip if present", () => {
    const headers = new Headers();
    headers.set("x-real-ip", "10.0.0.1");
    headers.set("x-forwarded-for", "1.1.1.1, 2.2.2.2");
    expect(clientIpFrom(headers, 1)).toBe("10.0.0.1");
  });

  it("returns unknown if neither is present", () => {
    const headers = new Headers();
    expect(clientIpFrom(headers, 1)).toBe("unknown");
  });
});
