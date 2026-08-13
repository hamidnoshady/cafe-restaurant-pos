import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWooWebhookSignature, wooWebhookSignature } from "./webhook-signature";

describe("wooWebhookSignature", () => {
  it("matches WooCommerce's documented base64 HMAC-SHA256", () => {
    const expected = createHmac("sha256", "secret").update("payload", "utf8").digest("base64");
    expect(wooWebhookSignature("payload", "secret")).toBe(expected);
  });
});

describe("verifyWooWebhookSignature", () => {
  const body = '{"id":123,"status":"processing"}';

  it("accepts a correct signature", () => {
    const header = wooWebhookSignature(body, "s3cret");
    expect(verifyWooWebhookSignature(body, header, "s3cret")).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifyWooWebhookSignature(body, null, "s3cret")).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const header = wooWebhookSignature(body, "s3cret");
    expect(verifyWooWebhookSignature(body, header, "wrong")).toBe(false);
  });

  it("rejects a tampered body", () => {
    const header = wooWebhookSignature(body, "s3cret");
    expect(verifyWooWebhookSignature('{"id":123,"status":"completed"}', header, "s3cret")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(verifyWooWebhookSignature(body, "not-base64!!", "s3cret")).toBe(false);
  });
});
