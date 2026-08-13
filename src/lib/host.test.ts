import { describe, expect, it } from "vitest";
import {
  businessHost,
  normalizeHost,
  parseHost,
  preferredProto,
  subdomainRoutingEnabled,
  swapHostLabel,
} from "./host";

const ROOT = "pos.eshobe.com";

describe("normalizeHost", () => {
  it("drops the port, the trailing dot, and case", () => {
    expect(normalizeHost("Acme.LocalTest.me:3000")).toBe("acme.localtest.me");
    expect(normalizeHost("acme.pos.eshobe.com.")).toBe("acme.pos.eshobe.com");
    expect(normalizeHost("  acme.pos.eshobe.com  ")).toBe("acme.pos.eshobe.com");
  });
});

describe("parseHost", () => {
  it("recognises the apex", () => {
    expect(parseHost(ROOT, ROOT)).toEqual({ kind: "apex", label: "" });
    expect(parseHost(`${ROOT}:3000`, ROOT)).toEqual({ kind: "apex", label: "" });
  });

  it("recognises the console's own host", () => {
    expect(parseHost(`admin.${ROOT}`, ROOT)).toEqual({ kind: "admin", label: "admin" });
  });

  it("recognises a business subdomain and returns its label", () => {
    expect(parseHost(`acme.${ROOT}`, ROOT)).toEqual({ kind: "business", label: "acme" });
    expect(parseHost(`biz-1a2b3c4d.${ROOT}:3000`, ROOT)).toEqual({ kind: "business", label: "biz-1a2b3c4d" });
  });

  it("works against a dev root that resolves to loopback", () => {
    expect(parseHost("acme.localtest.me:3000", "localtest.me")).toEqual({ kind: "business", label: "acme" });
  });

  it("refuses a host outside the root domain", () => {
    expect(parseHost("pos.example.com", ROOT)).toEqual({ kind: "unknown", label: "" });
    // Suffix-shaped but not a subdomain: "evilpos.eshobe.com" merely ends with
    // the root's text. Getting this wrong would hand an attacker-controlled
    // host a tenant label.
    expect(parseHost(`evil${ROOT}`, ROOT)).toEqual({ kind: "unknown", label: "" });
  });

  it("refuses a deeper subdomain, which no wildcard certificate covers", () => {
    expect(parseHost(`a.b.${ROOT}`, ROOT)).toEqual({ kind: "unknown", label: "" });
  });

  it("refuses everything when no root domain is configured", () => {
    expect(parseHost(`acme.${ROOT}`, "")).toEqual({ kind: "unknown", label: "" });
    expect(parseHost(`acme.${ROOT}`, undefined)).toEqual({ kind: "unknown", label: "" });
  });

  it("refuses a missing or empty host", () => {
    expect(parseHost(null, ROOT)).toEqual({ kind: "unknown", label: "" });
    expect(parseHost("", ROOT)).toEqual({ kind: "unknown", label: "" });
  });

  it("tolerates a root domain written with stray dots", () => {
    expect(parseHost(`acme.${ROOT}`, `.${ROOT}.`)).toEqual({ kind: "business", label: "acme" });
  });
});

describe("businessHost", () => {
  it("joins a label to the root domain", () => {
    expect(businessHost("acme", ROOT)).toBe("acme.pos.eshobe.com");
    expect(businessHost("acme", `.${ROOT}`)).toBe("acme.pos.eshobe.com");
  });
});

describe("swapHostLabel", () => {
  it("keeps the port the client is actually talking to", () => {
    // The regression this guards: building a redirect by mutating
    // request.nextUrl kept the *container's* port (3000) rather than the one
    // the browser used, so `/platform` behind Traefik pointed at
    // https://admin.example.com:3000/platform — a dead address.
    expect(swapHostLabel("acme.localtest.me:8443", "admin", "localtest.me")).toBe("admin.localtest.me:8443");
    expect(swapHostLabel("acme.localtest.me:3000", "beta", "localtest.me")).toBe("beta.localtest.me:3000");
  });

  it("emits no port when the request carried none, as on 443", () => {
    expect(swapHostLabel("acme.pos.eshobe.com", "admin", ROOT)).toBe("admin.pos.eshobe.com");
  });

  it("survives a missing Host header", () => {
    expect(swapHostLabel(null, "admin", ROOT)).toBe("admin.pos.eshobe.com");
    expect(swapHostLabel("", "admin", ROOT)).toBe("admin.pos.eshobe.com");
  });

  it("does not mistake an IPv6-looking host's colons for a port", () => {
    expect(swapHostLabel("acme.pos.eshobe.com:not-a-port", "admin", ROOT)).toBe("admin.pos.eshobe.com");
  });
});

describe("preferredProto", () => {
  it("trusts a proxy's x-forwarded-proto over the request's own scheme", () => {
    expect(preferredProto("https", "http:")).toBe("https");
    expect(preferredProto("http", "https:")).toBe("http");
  });

  it("takes the first hop when the header has been appended to", () => {
    expect(preferredProto("https, http", "http:")).toBe("https");
  });

  it("falls back to the request's own scheme when there is no proxy", () => {
    expect(preferredProto(null, "http:")).toBe("http");
    expect(preferredProto(undefined, "https:")).toBe("https");
  });

  it("ignores a value that is neither http nor https rather than trusting it", () => {
    // Client-supplied unless a proxy overwrote it, so `javascript:` and
    // friends must never end up as the scheme of a redirect we emit.
    expect(preferredProto("javascript", "https:")).toBe("https");
    expect(preferredProto("", "http:")).toBe("http");
  });
});

describe("subdomainRoutingEnabled", () => {
  it("is off unless explicitly turned on", () => {
    expect(subdomainRoutingEnabled({ ROOT_DOMAIN: ROOT })).toBe(false);
    expect(subdomainRoutingEnabled({ SUBDOMAIN_ROUTING: "off", ROOT_DOMAIN: ROOT })).toBe(false);
    expect(subdomainRoutingEnabled({ SUBDOMAIN_ROUTING: "true", ROOT_DOMAIN: ROOT })).toBe(false);
  });

  it("is on only with both the switch and a root domain", () => {
    expect(subdomainRoutingEnabled({ SUBDOMAIN_ROUTING: "on", ROOT_DOMAIN: ROOT })).toBe(true);
    expect(subdomainRoutingEnabled({ SUBDOMAIN_ROUTING: " ON ", ROOT_DOMAIN: ROOT })).toBe(true);
  });

  it("reads as off with no root domain, rather than failing every host closed", () => {
    expect(subdomainRoutingEnabled({ SUBDOMAIN_ROUTING: "on" })).toBe(false);
    expect(subdomainRoutingEnabled({ SUBDOMAIN_ROUTING: "on", ROOT_DOMAIN: "  " })).toBe(false);
  });
});
