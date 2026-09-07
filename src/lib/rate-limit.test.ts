import { describe, it, expect, afterEach } from "vitest";
import { clientIpFrom, internalBaseOrigin } from "./rate-limit";

describe("internalBaseOrigin", () => {
  const savedPort = process.env.PORT;
  const savedInternal = process.env.INTERNAL_BASE_URL;

  afterEach(() => {
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
    if (savedInternal === undefined) delete process.env.INTERNAL_BASE_URL;
    else process.env.INTERNAL_BASE_URL = savedInternal;
  });

  it("defaults to this process's loopback listener, not the request's public origin", () => {
    // Aimed at the public origin behind a TLS-terminating proxy, the call
    // died with "fetch failed" (no NAT hairpin / local DNS for the public
    // hostname) and the durable counter silently fell back per-process.
    expect(internalBaseOrigin({})).toBe("http://127.0.0.1:3000");
  });

  it("tracks PORT", () => {
    expect(internalBaseOrigin({ PORT: "8080" })).toBe("http://127.0.0.1:8080");
    // Garbage PORT falls back to 3000 rather than producing a bad URL.
    expect(internalBaseOrigin({ PORT: "not-a-port" })).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it("lets INTERNAL_BASE_URL override for split-tier deploys", () => {
    expect(
      internalBaseOrigin({ INTERNAL_BASE_URL: "http://internal-runtime:3100" }),
    ).toBe("http://internal-runtime:3100");
  });

  it("trims whitespace and strips trailing slashes so the path join never doubles up", () => {
    expect(
      internalBaseOrigin({ INTERNAL_BASE_URL: "  http://127.0.0.1:3000///  " }),
    ).toBe("http://127.0.0.1:3000");
  });

  it("ignores a whitespace-only INTERNAL_BASE_URL", () => {
    expect(internalBaseOrigin({ INTERNAL_BASE_URL: "   " })).toBe(
      "http://127.0.0.1:3000",
    );
  });
});

describe("rate-limit clientIpFrom", () => {
  it("resolves IP using trusted hops when > 0", () => {
    const headers = new Headers();
    headers.set("x-forwarded-for", "1.1.1.1, 2.2.2.2, 3.3.3.3");

    // 1 hop -> the last entry (3.3.3.3) was appended by our trusted proxy.
    // We don't trust 3.3.3.3 itself, so we use it as the client IP.
    expect(clientIpFrom(headers, 1)).toBe("3.3.3.3");

    // 2 hops -> our proxy appended 3.3.3.3, and we also trust 3.3.3.3,
    // which appended 2.2.2.2. We use 2.2.2.2.
    expect(clientIpFrom(headers, 2)).toBe("2.2.2.2");

    // > available hops -> clamp to 0 (the leftmost IP)
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

  it("ignores x-real-ip by default, because nothing in front of us sets it", () => {
    // Caddy appends to x-forwarded-for and never touches x-real-ip, so an
    // x-real-ip arriving here came from the client. Believing it hands the
    // caller their own rate-limit key.
    const headers = new Headers();
    headers.set("x-real-ip", "10.0.0.1");
    headers.set("x-forwarded-for", "1.1.1.1, 2.2.2.2");
    expect(clientIpFrom(headers, 1)).toBe("2.2.2.2");
  });

  it("honours x-real-ip only where the operator says the proxy overwrites it", () => {
    const previous = process.env.TRUST_X_REAL_IP;
    process.env.TRUST_X_REAL_IP = "true";
    try {
      const headers = new Headers();
      headers.set("x-real-ip", "10.0.0.1");
      headers.set("x-forwarded-for", "1.1.1.1, 2.2.2.2");
      expect(clientIpFrom(headers, 1)).toBe("10.0.0.1");
    } finally {
      if (previous === undefined) delete process.env.TRUST_X_REAL_IP;
      else process.env.TRUST_X_REAL_IP = previous;
    }
  });

  it("returns unknown if neither is present", () => {
    const headers = new Headers();
    expect(clientIpFrom(headers, 1)).toBe("unknown");
  });
});
