import { describe, expect, it } from "vitest";

import { assertPublicHttpsUrl, isPrivateAddress } from "./ssrf";

describe("isPrivateAddress", () => {
  it("names the ranges that reach this deployment's own network", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud instance metadata
      "100.64.0.1", // carrier-grade NAT
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.5", // IPv4-mapped: the same host, different notation
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("lets ordinary public addresses through", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("refuses anything that is not an address rather than guessing", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("assertPublicHttpsUrl", () => {
  it("requires https, so a plaintext hop cannot be aimed at the network either", async () => {
    expect(await assertPublicHttpsUrl("http://example.com/")).toMatchObject({ reason: "not_https" });
    expect(await assertPublicHttpsUrl("file:///etc/passwd")).toMatchObject({ reason: "not_https" });
  });

  it("rejects an address literal pointed inside", async () => {
    for (const url of [
      "https://127.0.0.1/push",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5:8120/",
      "https://[::1]/",
    ]) {
      expect(await assertPublicHttpsUrl(url), url).toMatchObject({ ok: false, reason: "private_host" });
    }
  });

  it("rejects names for this machine however they would resolve", async () => {
    for (const url of ["https://localhost/", "https://db.internal/", "https://pos.cafe.lan.local/"]) {
      expect(await assertPublicHttpsUrl(url), url).toMatchObject({ ok: false });
    }
  });

  it("refuses a name it cannot resolve rather than assuming it is fine", async () => {
    const result = await assertPublicHttpsUrl(
      "https://this-name-does-not-exist.invalid/push",
    );

    expect(result).toMatchObject({ ok: false, reason: "unresolvable_host" });
  });

  it("rejects a bare url string that is not a url", async () => {
    expect(await assertPublicHttpsUrl("nonsense")).toMatchObject({ ok: false, reason: "not_a_url" });
  });
});
