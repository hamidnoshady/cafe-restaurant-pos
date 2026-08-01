import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  apiKeyDisplayPrefix,
  createApiKey,
  hashApiKey,
  parseApiBearerToken,
} from "./api-auth";

describe("public API key primitives", () => {
  it("mints namespaced, URL-safe secrets and exposes only a short display prefix", () => {
    const key = createApiKey();
    expect(key).toMatch(/^posk_live_[A-Za-z0-9_-]{43}$/);
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(apiKeyDisplayPrefix(key)).toBe(key.slice(0, 16));
    expect(apiKeyDisplayPrefix(key)).not.toBe(key);
  });

  it("hashes keys deterministically without retaining the secret", () => {
    const key = "posk_live_example-secret";
    expect(hashApiKey(key)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(hashApiKey(key)).not.toBe(key);
    expect(hashApiKey(key)).not.toBe(hashApiKey("posk_live_another-secret"));
  });

  it("accepts only a single correctly namespaced bearer token", () => {
    const request = (authorization: string | null) =>
      new Request("https://example.test/api/v1/orders", {
        headers: authorization ? { authorization } : {},
      });

    expect(parseApiBearerToken(request("Bearer posk_live_a1b2c3"))).toBe("posk_live_a1b2c3");
    expect(parseApiBearerToken(request("bearer posk_live_a1b2c3"))).toBe("posk_live_a1b2c3");
    expect(parseApiBearerToken(request("Basic posk_live_a1b2c3"))).toBeNull();
    expect(parseApiBearerToken(request("Bearer not-a-pos-key"))).toBeNull();
    expect(parseApiBearerToken(request("Bearer posk_live_one another"))).toBeNull();
    expect(parseApiBearerToken(request(null))).toBeNull();
  });
});
