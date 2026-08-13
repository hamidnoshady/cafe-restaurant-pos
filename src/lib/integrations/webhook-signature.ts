/**
 * Phase 23 (issue #118) — WooCommerce webhook signature verification.
 *
 * WooCommerce signs every webhook delivery with
 * `base64(hmac_sha256(raw_payload, webhook_secret))`, sent in the
 * `X-WC-Webhook-Signature` header. This module computes and verifies that
 * signature in constant time so a delivery we can't authenticate is refused
 * before its payload is trusted (and before any tenant is resolved).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const WOO_SIGNATURE_HEADER = "x-wc-webhook-signature";
export const WOO_DELIVERY_ID_HEADER = "x-wc-webhook-delivery-id";

export function wooWebhookSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

/** True only when `header` is present, well-formed, and matches the HMAC. */
export function verifyWooWebhookSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(wooWebhookSignature(rawBody, secret));
  const received = Buffer.from(header);
  if (expected.length !== received.length) return false;
  try {
    return timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}
