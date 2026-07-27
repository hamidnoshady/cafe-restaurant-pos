import { describe, expect, it } from "vitest";
import { platformSessionCookieOptions, signPlatformSession, verifyPlatformSession } from "./platform-auth-edge";
import { signSession } from "./auth-edge";

describe("platformSessionCookieOptions", () => {
  it("scopes the cookie to the whole app, not just /platform", () => {
    // Regression test: per RFC 6265 cookie-path matching, a cookie scoped to
    // Path=/platform is a directory-prefix match and is NEVER sent for a
    // request under /api/platform/* — "/api" and "/platform" don't share a
    // path prefix. That silently broke every console API call: login would
    // "succeed" (the cookie was set) and then every following request to
    // /api/platform/* would 401, because requirePlatformAdmin never actually
    // saw the cookie the browser was supposed to attach.
    //
    // Isolation from the tenant realm was never resting on the cookie path —
    // it's the distinct cookie name plus the `realm` claim check in
    // verifyPlatformSession — so this must stay "/", not "/platform".
    expect(platformSessionCookieOptions().path).toBe("/");
  });

  it("stays httpOnly and lax regardless of path", () => {
    const options = platformSessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
  });
});

describe("signPlatformSession / verifyPlatformSession", () => {
  it("round-trips a platform session", async () => {
    const token = await signPlatformSession({
      padmin: "admin-1",
      role: "engineer",
      fullName: "Engineer",
      email: "engineer@example.com",
    });
    const verified = await verifyPlatformSession(token);
    expect(verified).toMatchObject({ padmin: "admin-1", role: "engineer" });
  });

  it("rejects a tenant session token — the two realms share a secret but not a claim", async () => {
    const tenantToken = await signSession({
      sub: "user-1",
      role: "owner",
      businessId: "biz-1",
      locationId: null,
      fullName: "Owner",
    });
    expect(await verifyPlatformSession(tenantToken)).toBeNull();
  });
});
