import { describe, expect, it } from "vitest";
import { signSession, verifySession, type SessionPayload } from "./auth-edge";
import { signPlatformSession } from "./platform-auth-edge";

const BASE: SessionPayload = {
  sub: "user-1",
  role: "owner",
  businessId: "biz-1",
  locationId: null,
  fullName: "Owner",
};

describe("signSession / verifySession", () => {
  it("round-trips a session signed by this realm", async () => {
    const token = await signSession(BASE);
    const verified = await verifySession(token);
    expect(verified).toMatchObject({ sub: "user-1", role: "owner", businessId: "biz-1" });
  });

  it("rejects a garbage token", async () => {
    expect(await verifySession("not-a-real-token")).toBeNull();
  });

  it("carries the business slug when the token was minted with one", async () => {
    const token = await signSession({ ...BASE, businessSlug: "alpha-cafe" });
    const verified = await verifySession(token);
    expect(verified?.businessSlug).toBe("alpha-cafe");
  });

  it("verifies a token minted before businessSlug existed, with the field simply absent", async () => {
    const token = await signSession(BASE);
    const verified = await verifySession(token);
    expect(verified?.businessSlug).toBeUndefined();
  });

  it("rejects a platform-admin session token — the two realms share a secret but not a claim", async () => {
    // Phase 17 security review: before the `realm` claim existed here,
    // a platform token verified fine against verifySession since nothing
    // checked what minted it, only that the signature was valid.
    const platformToken = await signPlatformSession({
      padmin: "admin-1",
      role: "owner",
      fullName: "Admin",
      email: "admin@example.com",
    });
    expect(await verifySession(platformToken)).toBeNull();
  });
});
