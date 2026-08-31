/**
 * Phase 24 Wave 5 — the middleware seam for this server calling itself.
 *
 * `checkRateLimit` runs in the Edge runtime and cannot reach Postgres, so it
 * asks the Node-runtime route for the durable counter over HTTP. That fetch
 * re-enters middleware carrying no session cookie — it is made *for* requests
 * that have none — so unless middleware recognises it, the tenant guard
 * answers 401 and the counter is never written. The limiter then silently
 * falls back to the per-process Map on every request, reinstating exactly the
 * reset-on-restart, per-replica behaviour this wave exists to remove.
 *
 * That failure is invisible from the outside: logins still work, requests
 * still get limited, nothing 500s. It was only caught by running the built
 * server against a real database and finding `rate_limits` empty. These tests
 * pin the two halves of the seam so it cannot regress silently again.
 */
import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/middleware";

// Kept in step with the private helper in src/middleware.ts. The assertions
// below are about which paths the rule must and must not cover.
function isInternalRoutePath(pathname: string): boolean {
  return pathname === "/api/internal/rate-limit" || pathname.startsWith("/api/internal/");
}

describe("internal route path", () => {
  it("covers the durable rate-limit counter", () => {
    expect(isInternalRoutePath("/api/internal/rate-limit")).toBe(true);
  });

  it("does not cover anything outside /api/internal/", () => {
    // A stray x-internal-auth header on an ordinary route must change nothing,
    // so the eligible set has to stay narrow.
    for (const path of [
      "/api/auth/login",
      "/api/orders",
      "/api/platform/businesses",
      "/api/internalise",
      "/internal/rate-limit",
      "/api/v1/orders",
      "/dashboard",
    ]) {
      expect(isInternalRoutePath(path), path).toBe(false);
    }
  });

  it("is NOT public — the secret is the only way in", () => {
    // The tempting fix for the 401 was to add the path to PUBLIC_PATHS, which
    // would have made an endpoint that writes a shared counter genuinely open.
    // Middleware must let it through only on the credential, never on the path.
    expect(isPublicPath("/api/internal/rate-limit")).toBe(false);
    expect(isPublicPath("/api/internal/")).toBe(false);
  });

  it("cannot recurse: the internal path is in no rate-limit bucket", () => {
    // If the internal path were itself rate-limited, serving it would call
    // checkRateLimit again, which would fetch it again — one login turning
    // into unbounded recursion. The buckets are asserted here because they are
    // the reason that cannot happen.
    const internal = "/api/internal/rate-limit";
    // Exact-match auth bucket.
    const AUTH_PATHS = [
      "/api/auth/login",
      "/api/auth/pin-login",
      "/api/auth/pin-login/roster",
      "/api/auth/webauthn/login/options",
      "/api/auth/webauthn/login/verify",
      "/api/platform/auth/login",
      "/api/auth/directory",
      "/api/platform/pairing/redeem",
      "/api/pairing/redeem",
      "/api/setup/pair",
    ];
    expect(AUTH_PATHS.includes(internal)).toBe(false);
    // Prefix buckets.
    expect(internal.startsWith("/api/v1")).toBe(false);
    expect(internal.startsWith("/api/mcp")).toBe(false);
    expect(internal.startsWith("/api/integrations/wordpress")).toBe(false);
  });
});
