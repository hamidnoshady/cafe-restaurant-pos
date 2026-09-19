import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  cspMode,
  generateNonce,
  contentSecurityPolicy,
  staticSecurityHeaders,
} from "./security-headers";

describe("security-headers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("cspMode defaults to report-only", () => {
    delete process.env.CSP_MODE;
    expect(cspMode()).toBe("report-only");

    process.env.CSP_MODE = "off";
    expect(cspMode()).toBe("off");

    process.env.CSP_MODE = "enforce";
    expect(cspMode()).toBe("enforce");
  });

  it("generateNonce produces a 32-character hex string", () => {
    const nonce = generateNonce();
    expect(typeof nonce).toBe("string");
    expect(nonce.length).toBe(32);
    expect(/^[0-9a-f]+$/.test(nonce)).toBe(true);
  });

  it("contentSecurityPolicy includes nonce and frame-ancestors", () => {
    const csp = contentSecurityPolicy("test-nonce", { https: false });
    expect(csp).toContain("'nonce-test-nonce'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("upgrade-insecure-requests");

    const cspHttps = contentSecurityPolicy("test-nonce", { https: true });
    expect(cspHttps).toContain("upgrade-insecure-requests");

    const reportOnly = contentSecurityPolicy("test-nonce", { https: true, reportOnly: true });
    expect(reportOnly).not.toContain("upgrade-insecure-requests");
  });

  it("allows connected website media over HTTP(S) without widening scripts or connections", () => {
    const csp = contentSecurityPolicy("test-nonce", { https: false });
    expect(csp).toContain("img-src 'self' data: blob: http: https:");
    expect(csp).not.toContain("script-src http:");
    expect(csp).not.toContain("connect-src http: https:");
  });

  it("allows only the loopback print-agent origins in connect-src", () => {
    process.env.NEXT_PUBLIC_PRINT_AGENT_URL = "http://localhost:9555";
    const csp = contentSecurityPolicy("test-nonce", { https: true });
    expect(csp).toContain("http://127.0.0.1:9123");
    expect(csp).toContain("http://localhost:9123");
    expect(csp).toContain("http://localhost:9555");

    process.env.NEXT_PUBLIC_PRINT_AGENT_URL = "https://attacker.example";
    expect(contentSecurityPolicy("test-nonce", { https: true })).not.toContain("attacker.example");
  });

  it("staticSecurityHeaders respects https parameter", () => {
    const headersHttp = staticSecurityHeaders({ https: false });
    expect(headersHttp["Permissions-Policy"]).toContain("camera=(self)");
    expect(headersHttp["Permissions-Policy"]).toContain("publickey-credentials-get=(self)");
    expect(headersHttp["Permissions-Policy"]).toContain("loopback-network=(self)");
    expect(headersHttp["Permissions-Policy"]).toContain("local-network-access=(self)");
    expect(headersHttp["Strict-Transport-Security"]).toBeUndefined();

    const headersHttps = staticSecurityHeaders({ https: true });
    expect(headersHttps["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains");
  });
});
