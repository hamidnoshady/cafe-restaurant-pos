import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectedOrigin,
  expectedOriginsFor,
  rpId,
  rpName,
  signChallenge,
  verifyChallenge,
} from "./webauthn";

describe("rpId/rpName/expectedOrigin", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("falls back to localhost defaults when unset", () => {
    delete process.env.WEBAUTHN_RP_ID;
    delete process.env.WEBAUTHN_RP_NAME;
    delete process.env.WEBAUTHN_ORIGIN;
    delete process.env.ROOT_DOMAIN;
    expect(rpId()).toBe("localhost");
    expect(rpName()).toBeTruthy();
    expect(expectedOrigin()).toBe("http://localhost:3000");
  });

  it("reads WEBAUTHN_RP_ID/WEBAUTHN_RP_NAME from the environment", () => {
    process.env.WEBAUTHN_RP_ID = "pos.example.com";
    process.env.WEBAUTHN_RP_NAME = "My Cafe";
    expect(rpId()).toBe("pos.example.com");
    expect(rpName()).toBe("My Cafe");
  });

  it("splits a comma-separated WEBAUTHN_ORIGIN into a trimmed array", () => {
    process.env.WEBAUTHN_ORIGIN = "https://a.example.com, https://b.example.com";
    expect(expectedOrigin()).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("uses ROOT_DOMAIN as the RP ID, so one credential works on every business host", () => {
    // The RP ID has to be a registrable suffix of the page's origin. Binding
    // it to one business's host would make every ceremony on another host fail.
    delete process.env.WEBAUTHN_RP_ID;
    process.env.ROOT_DOMAIN = "ac.eshobe.com";
    expect(rpId()).toBe("ac.eshobe.com");

    // An explicit value still wins, for a deployment served from one host.
    process.env.WEBAUTHN_RP_ID = "pos.example.com";
    expect(rpId()).toBe("pos.example.com");
  });
});

describe("expectedOriginsFor", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("adds the request's own origin when its host is under ROOT_DOMAIN", () => {
    // A business host cannot be listed in WEBAUTHN_ORIGIN ahead of time — a new
    // business is a database row — so it is derived from the request instead.
    process.env.ROOT_DOMAIN = "ac.eshobe.com";
    process.env.WEBAUTHN_ORIGIN = "https://ac.eshobe.com";
    expect(expectedOriginsFor("biz1.ac.eshobe.com", "https")).toEqual([
      "https://ac.eshobe.com",
      "https://biz1.ac.eshobe.com",
    ]);
  });

  it("keeps the port, because the browser's origin carries it", () => {
    process.env.ROOT_DOMAIN = "localtest.me";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    expect(expectedOriginsFor("acme.localtest.me:3000", null)).toEqual([
      "http://localhost:3000",
      "https://acme.localtest.me:3000",
    ]);
  });

  it("drops a host that is not under ROOT_DOMAIN, so a forged Host cannot widen it", () => {
    process.env.ROOT_DOMAIN = "ac.eshobe.com";
    process.env.WEBAUTHN_ORIGIN = "https://ac.eshobe.com";
    expect(expectedOriginsFor("evil.example.com", "https")).toEqual(["https://ac.eshobe.com"]);
    // Suffix-shaped but not a subdomain, and one level too deep: both unknown.
    expect(expectedOriginsFor("evilac.eshobe.com", "https")).toEqual(["https://ac.eshobe.com"]);
    expect(expectedOriginsFor("a.biz1.ac.eshobe.com", "https")).toEqual(["https://ac.eshobe.com"]);
  });

  it("does not repeat an origin already configured", () => {
    process.env.ROOT_DOMAIN = "ac.eshobe.com";
    process.env.WEBAUTHN_ORIGIN = "https://biz1.ac.eshobe.com";
    expect(expectedOriginsFor("biz1.ac.eshobe.com", "https")).toEqual(["https://biz1.ac.eshobe.com"]);
  });

  it("falls back to the configured origins with no root domain", () => {
    delete process.env.ROOT_DOMAIN;
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    expect(expectedOriginsFor("acme.localtest.me:3000", null)).toEqual(["http://localhost:3000"]);
  });
});

describe("ceremony challenge tokens", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips: what's signed is what verify returns, for matching purpose/employee/business", async () => {
    const token = await signChallenge({
      purpose: "webauthn-register",
      employeeId: "emp-1",
      businessId: "biz-1",
      challenge: "the-challenge",
    });
    const result = await verifyChallenge(token, "webauthn-register", "emp-1", "biz-1");
    expect(result).toBe("the-challenge");
  });

  it("rejects a mismatched purpose (a login challenge can't complete a registration)", async () => {
    const token = await signChallenge({
      purpose: "webauthn-authenticate",
      employeeId: "emp-1",
      businessId: "biz-1",
      challenge: "c",
    });
    expect(await verifyChallenge(token, "webauthn-register", "emp-1", "biz-1")).toBeNull();
  });

  it("rejects a mismatched employeeId", async () => {
    const token = await signChallenge({
      purpose: "webauthn-register",
      employeeId: "emp-1",
      businessId: "biz-1",
      challenge: "c",
    });
    expect(await verifyChallenge(token, "webauthn-register", "emp-2", "biz-1")).toBeNull();
  });

  it("rejects a mismatched businessId", async () => {
    const token = await signChallenge({
      purpose: "webauthn-register",
      employeeId: "emp-1",
      businessId: "biz-1",
      challenge: "c",
    });
    expect(await verifyChallenge(token, "webauthn-register", "emp-1", "biz-2")).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const token = await signChallenge({
      purpose: "webauthn-register",
      employeeId: "emp-1",
      businessId: "biz-1",
      challenge: "c",
    });
    expect(await verifyChallenge(`${token}x`, "webauthn-register", "emp-1", "biz-1")).toBeNull();
  });

  it("expires after its TTL", async () => {
    const token = await signChallenge({
      purpose: "webauthn-register",
      employeeId: "emp-1",
      businessId: "biz-1",
      challenge: "c",
    });
    vi.setSystemTime(new Date("2026-01-01T00:02:01Z")); // 121s later — past the 120s TTL
    expect(await verifyChallenge(token, "webauthn-register", "emp-1", "biz-1")).toBeNull();
  });

  it("is still valid just under its TTL", async () => {
    const token = await signChallenge({
      purpose: "webauthn-register",
      employeeId: "emp-1",
      businessId: "biz-1",
      challenge: "c",
    });
    vi.setSystemTime(new Date("2026-01-01T00:01:55Z")); // 115s later — still inside the 120s TTL
    expect(await verifyChallenge(token, "webauthn-register", "emp-1", "biz-1")).toBe("c");
  });
});
