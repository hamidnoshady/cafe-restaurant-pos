import { describe, expect, it } from "vitest";
import { platformSessionCookieOptions } from "./platform-auth-edge";

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
