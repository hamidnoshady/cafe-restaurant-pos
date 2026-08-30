import { describe, expect, it } from "vitest";

import {
  ESHOBE_SIGNATURE_HEADER,
  cmsPathTag,
  cmsSiteTag,
  eshobeSignature,
  verifyEshobeSignature,
} from "./webhook";

const SECRET = "payload-secret-for-tests";

describe("eshobeSignature", () => {
  it("produces the sha256=<hex> form the CMS sends", () => {
    expect(eshobeSignature("{}", SECRET)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
  it("is deterministic for the same body and key", () => {
    expect(eshobeSignature('{"siteId":"s1"}', SECRET)).toBe(eshobeSignature('{"siteId":"s1"}', SECRET));
  });
});

describe("verifyEshobeSignature", () => {
  const rawBody = JSON.stringify({ paths: ["/acme.ir/en"], siteId: "s1", timestamp: "2026-08-30T00:00:00Z" });
  const header = eshobeSignature(rawBody, SECRET);

  it("accepts a genuine signature", () => {
    expect(verifyEshobeSignature(rawBody, header, SECRET)).toBe(true);
  });
  it("rejects a missing header", () => {
    expect(verifyEshobeSignature(rawBody, null, SECRET)).toBe(false);
  });
  it("rejects a wrong secret", () => {
    expect(verifyEshobeSignature(rawBody, header, "other-secret")).toBe(false);
  });
  it("rejects a tampered body", () => {
    expect(verifyEshobeSignature(`${rawBody}x`, header, SECRET)).toBe(false);
  });
  it("rejects a header without the sha256= prefix", () => {
    expect(verifyEshobeSignature(rawBody, header.slice(7), SECRET)).toBe(false);
  });
});

describe("cache tags", () => {
  it("derives stable per-site and per-path tags", () => {
    expect(cmsSiteTag("site-1")).toBe("eshobe-cms:site:site-1");
    expect(cmsPathTag("site-1", "/en/pricing")).toBe("eshobe-cms:site-1:/en/pricing");
  });
});

describe("header constant", () => {
  it("names the signature header the CMS uses", () => {
    expect(ESHOBE_SIGNATURE_HEADER).toBe("x-eshobe-signature");
  });
});
