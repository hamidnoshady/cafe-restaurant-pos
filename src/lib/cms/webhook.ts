/**
 * Eshobe CMS — publish-webhook verification and cache-tag derivation.
 *
 * The CMS (eshobe-cms `src/lib/renderer-webhook.ts`) signs every notice:
 *
 *     POST $REVALIDATE_WEBHOOK_URL
 *     content-type: application/json
 *     x-eshobe-signature: sha256=<hex hmac of the raw body, keyed by PAYLOAD_SECRET>
 *     { "paths": ["/acme.ir/en/pricing"], "siteId": "…", "timestamp": "ISO-8601" }
 *
 * The receiver must verify the signature over the RAW body before acting —
 * an unauthenticated endpoint that purges caches is a denial-of-service
 * button, and "invalidate everything" is one leaked URL away.
 *
 * Tag derivation is kept pure (no `next/cache`) so it is unit-testable; the
 * route handler performs the actual `revalidateTag` calls.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const ESHOBE_SIGNATURE_HEADER = "x-eshobe-signature";

/** `sha256=<hex hmac>` — the exact string the CMS puts in the header. */
export function eshobeSignature(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

/** True only when `header` is present, well-formed and matches the HMAC. */
export function verifyEshobeSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(eshobeSignature(rawBody, secret));
  const received = Buffer.from(header);
  if (expected.length !== received.length) return false;
  try {
    return timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

/** Cache tag for one site's whole CMS slice. */
export function cmsSiteTag(siteId: string): string {
  return `eshobe-cms:site:${siteId}`;
}

/** Cache tag for one site path — so a publish can invalidate just that page. */
export function cmsPathTag(siteId: string, path: string): string {
  return `eshobe-cms:${siteId}:${path}`;
}

/** The webhook body the CMS sends. */
export interface CmsRevalidateNotice {
  paths: string[];
  siteId: string;
  timestamp: string;
}
