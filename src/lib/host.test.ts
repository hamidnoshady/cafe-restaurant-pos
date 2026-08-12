import { describe, expect, it } from "vitest";
import { businessHost, normalizeHost, parseHost, subdomainRoutingEnabled } from "./host";

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
