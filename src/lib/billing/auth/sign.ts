import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const BILLING_SIGNATURE_HEADER = "x-eshobe-billing-signature";
export const BILLING_TIMESTAMP_HEADER = "x-eshobe-billing-timestamp";
export const BILLING_KEY_HEADER = "x-eshobe-billing-key";

/** Five minutes — matches eshobe-cms billing auth. */
export const BILLING_REPLAY_WINDOW_MS = 5 * 60 * 1000;

export type BillingServiceScope = "billing.usage.write" | "billing.entitlement.write";

/** `sha256=<hex>` over `<unix-seconds>.<raw body>`. */
export function signBillingBody(secret: string, timestampSec: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex")}`;
}

export function billingBodyFingerprint(timestampSec: string, body: string): string {
  return createHash("sha256").update(`${timestampSec}.${body}`).digest("hex");
}

export function verifyBillingBodySignature(input: {
  secret: string;
  timestamp: string;
  signature: string;
  rawBody: string;
  now?: number;
}): { ok: true } | { ok: false; code: string } {
  const timestamp = input.timestamp.trim();
  if (!/^\d{10}$/.test(timestamp)) return { ok: false, code: "STALE_TIMESTAMP" };
  const skew = Math.abs((input.now ?? Date.now()) - Number(timestamp) * 1000);
  if (skew > BILLING_REPLAY_WINDOW_MS) return { ok: false, code: "STALE_TIMESTAMP" };
  const expected = signBillingBody(input.secret, timestamp, input.rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: "BAD_SIGNATURE" };
  return { ok: true };
}
