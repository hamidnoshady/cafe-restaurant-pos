import { describe, it, expect, beforeEach } from "vitest";
import { query } from "../src/lib/db";
import { 
  checkAuthLockout, 
  recordAuthFailure, 
  recordAuthSuccess,
  clearAuthLockout
} from "../src/lib/login-lockout-service";
import { PLATFORM_LOCKOUT_POLICY, PASSWORD_LOCKOUT_POLICY } from "../src/lib/login-lockout";

describe("auth-lockout integration", () => {
  beforeEach(async () => {
    await query("TRUNCATE TABLE auth_login_attempts CASCADE");
  });

  it("N failures lock, a success clears the streak, realms don't share a bucket", async () => {
    const email = "test@example.com";
    
    // Fail 3 times in platform_admin
    await recordAuthFailure("platform_admin", email);
    await recordAuthFailure("platform_admin", email);
    await recordAuthFailure("platform_admin", email);

    const platformStatus = await checkAuthLockout("platform_admin", email, PLATFORM_LOCKOUT_POLICY);
    expect(platformStatus.locked).toBe(true);

    // Tenant password should not share the bucket
    const tenantStatus = await checkAuthLockout("tenant_password", email, PASSWORD_LOCKOUT_POLICY);
    expect(tenantStatus.locked).toBe(false);

    // Success clears the streak
    await recordAuthSuccess("platform_admin", email);
    const platformStatus2 = await checkAuthLockout("platform_admin", email, PLATFORM_LOCKOUT_POLICY);
    expect(platformStatus2.locked).toBe(false);
  });
});
