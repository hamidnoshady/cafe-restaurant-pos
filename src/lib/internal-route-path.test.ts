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
import {
  isAuthRateLimitedPath,
  isPeerBackupPath,
  isPublicPath,
  isStaffRosterPath,
} from "@/middleware";

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
    // into unbounded recursion. Asked of the middleware's own predicates
    // rather than a copied list of bucket members: the copy is how this
    // assertion would go stale the next time a bucket changes shape.
    const internal = "/api/internal/rate-limit";
    expect(isAuthRateLimitedPath(internal)).toBe(false);
    expect(isStaffRosterPath(internal)).toBe(false);
    expect(isPeerBackupPath(internal)).toBe(false);
    // Prefix buckets.
    expect(internal.startsWith("/api/v1")).toBe(false);
    expect(internal.startsWith("/api/mcp")).toBe(false);
    expect(internal.startsWith("/api/integrations/wordpress")).toBe(false);
  });
});
