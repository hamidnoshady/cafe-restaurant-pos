import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_TIMESTAMP_SKEW_MS,
  PLUGIN_TOKEN_PREFIX,
  generatePluginToken,
  hashPluginToken,
  looksLikePluginToken,
  pluginSignature,
  pluginSigningString,
  verifyPluginEnvelope,
} from "./plugin-link";

const TOKEN = "wplink_TESTTOKEN";
const BODY = '{"events":[{"topic":"order.created","payload":{"id":7,"total":"12.50"}}]}';
const NOW = 1_755_300_000_000;
const TIMESTAMP = String(NOW);
const NONCE = "abcdEFGH-_12";

function envelope(overrides: Partial<{ signature: string; timestamp: string; nonce: string }> = {}) {
  return {
    signature: pluginSignature(TOKEN, TIMESTAMP, NONCE, BODY),
    timestamp: TIMESTAMP,
    nonce: NONCE,
    ...overrides,
  };
}

describe("generatePluginToken", () => {
  it("is namespaced and recognisable, so a credential pasted into the wrong box is caught by shape", () => {
    const token = generatePluginToken();
    expect(token.startsWith(PLUGIN_TOKEN_PREFIX)).toBe(true);
    expect(looksLikePluginToken(token)).toBe(true);
    expect(looksLikePluginToken("posk_live_abc")).toBe(false);
  });

  it("does not repeat itself", () => {
    expect(new Set(Array.from({ length: 50 }, generatePluginToken)).size).toBe(50);
  });

  it("stores only a SHA-256, matching how every other credential here is kept", () => {
    expect(hashPluginToken(TOKEN)).toBe(createHash("sha256").update(TOKEN).digest("hex"));
  });
});

describe("pluginSigningString", () => {
  /**
   * Pinned rather than derived. The PHP client in
   * wordpress-plugin/…/class-pos-client.php builds this string independently,
   * and if the two ever drift, every request becomes a 401 with nothing in a
   * log to explain it. A literal here is what makes such a change fail loudly
   * in CI instead of quietly in production.
   */
  it("is `v1:{timestamp}:{nonce}:{sha256hex(body)}`", () => {
    expect(pluginSigningString(TIMESTAMP, NONCE, BODY)).toBe(
      `v1:${TIMESTAMP}:${NONCE}:${createHash("sha256").update(BODY, "utf8").digest("hex")}`,
    );
    expect(pluginSigningString(TIMESTAMP, NONCE, BODY)).toBe(
      "v1:1755300000000:abcdEFGH-_12:4384d63395400f31c80e9d00a9621e16fd941e23cc62b95a78ab2a70172b9591",
    );
  });

  it("signs with HMAC-SHA256 keyed by the token, in hex", () => {
    expect(pluginSignature(TOKEN, TIMESTAMP, NONCE, BODY)).toBe(
      createHmac("sha256", TOKEN).update(pluginSigningString(TIMESTAMP, NONCE, BODY)).digest("hex"),
    );
    // The value the PHP side produces for these exact inputs.
    expect(pluginSignature(TOKEN, TIMESTAMP, NONCE, BODY)).toBe(
      "e76e5609790615adc75e658bcabf2b579171a7d0ccfc8f15b18400cfd6ea5dfc",
    );
  });

  it("changes when any one of the three inputs changes", () => {
    const base = pluginSignature(TOKEN, TIMESTAMP, NONCE, BODY);
    expect(pluginSignature(TOKEN, String(NOW + 1), NONCE, BODY)).not.toBe(base);
    expect(pluginSignature(TOKEN, TIMESTAMP, "otherNonce1", BODY)).not.toBe(base);
    expect(pluginSignature(TOKEN, TIMESTAMP, NONCE, `${BODY} `)).not.toBe(base);
    expect(pluginSignature("wplink_OTHER", TIMESTAMP, NONCE, BODY)).not.toBe(base);
  });
});

describe("verifyPluginEnvelope", () => {
  it("accepts a correctly signed request", () => {
    expect(verifyPluginEnvelope(TOKEN, envelope(), BODY, NOW)).toEqual({
      ok: true,
      envelope: { timestamp: TIMESTAMP, nonce: NONCE },
    });
  });

  it("accepts the `sha256=` prefix WooCommerce-style clients tend to add", () => {
    const signed = envelope();
    expect(verifyPluginEnvelope(TOKEN, { ...signed, signature: `sha256=${signed.signature}` }, BODY, NOW).ok).toBe(true);
  });

  it("names each missing header rather than reporting a generic failure", () => {
    expect(verifyPluginEnvelope(TOKEN, envelope({ signature: "" }), BODY, NOW)).toEqual({
      ok: false,
      error: "missing_signature",
    });
    expect(verifyPluginEnvelope(TOKEN, envelope({ timestamp: "" }), BODY, NOW)).toEqual({
      ok: false,
      error: "missing_timestamp",
    });
    expect(verifyPluginEnvelope(TOKEN, envelope({ nonce: "" }), BODY, NOW)).toEqual({
      ok: false,
      error: "missing_nonce",
    });
  });

  it("rejects a nonce outside the charset a primary key and a signing string can carry", () => {
    expect(verifyPluginEnvelope(TOKEN, envelope({ nonce: "short" }), BODY, NOW).ok).toBe(false);
    expect(verifyPluginEnvelope(TOKEN, envelope({ nonce: "has spaces here" }), BODY, NOW)).toEqual({
      ok: false,
      error: "bad_nonce",
    });
    expect(verifyPluginEnvelope(TOKEN, envelope({ nonce: "a".repeat(129) }), BODY, NOW)).toEqual({
      ok: false,
      error: "bad_nonce",
    });
  });

  it("accepts clock drift inside the window, in both directions", () => {
    for (const skew of [-PLUGIN_TIMESTAMP_SKEW_MS + 1, -60_000, 0, 60_000, PLUGIN_TIMESTAMP_SKEW_MS - 1]) {
      expect(verifyPluginEnvelope(TOKEN, envelope(), BODY, NOW + skew).ok).toBe(true);
    }
  });

  it("rejects a captured request once it falls outside the window", () => {
    expect(verifyPluginEnvelope(TOKEN, envelope(), BODY, NOW + PLUGIN_TIMESTAMP_SKEW_MS + 1)).toEqual({
      ok: false,
      error: "stale_timestamp",
    });
    // A future-dated request is refused on the same terms — a clock skewed the
    // other way would otherwise extend a signature's life indefinitely.
    expect(verifyPluginEnvelope(TOKEN, envelope(), BODY, NOW - PLUGIN_TIMESTAMP_SKEW_MS - 1)).toEqual({
      ok: false,
      error: "stale_timestamp",
    });
  });

  it("reports staleness before signature validity, so a replay is never called valid", () => {
    // Correctly signed and correctly hashed, but outside the window.
    expect(verifyPluginEnvelope(TOKEN, envelope(), BODY, NOW + 10 * PLUGIN_TIMESTAMP_SKEW_MS).ok).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(verifyPluginEnvelope(TOKEN, envelope({ timestamp: "not-a-number" }), BODY, NOW)).toEqual({
      ok: false,
      error: "stale_timestamp",
    });
  });

  it("rejects a body altered in transit, which is the point of signing the body at all", () => {
    const signed = envelope();
    const tampered = BODY.replace('"12.50"', '"1250.00"');
    expect(verifyPluginEnvelope(TOKEN, signed, tampered, NOW)).toEqual({ ok: false, error: "bad_signature" });
  });

  it("rejects a signature made with a different token", () => {
    const other = {
      signature: pluginSignature("wplink_OTHER", TIMESTAMP, NONCE, BODY),
      timestamp: TIMESTAMP,
      nonce: NONCE,
    };
    expect(verifyPluginEnvelope(TOKEN, other, BODY, NOW)).toEqual({ ok: false, error: "bad_signature" });
  });

  it("rejects a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on a length mismatch, so this is a guard, not a
    // formality: a one-character signature must be a 401, not a 500.
    expect(verifyPluginEnvelope(TOKEN, envelope({ signature: "a" }), BODY, NOW)).toEqual({
      ok: false,
      error: "bad_signature",
    });
  });

  it("rejects a request whose headers were lifted onto a different body", () => {
    const signed = envelope();
    expect(verifyPluginEnvelope(TOKEN, signed, "{}", NOW)).toEqual({ ok: false, error: "bad_signature" });
  });
});
