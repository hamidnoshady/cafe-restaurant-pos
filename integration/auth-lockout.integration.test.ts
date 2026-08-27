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

  it("checkAuthLockout runs against the real table and counts only failures", async () => {
    // The unit test pins the SQL text; this pins that the SQL is *valid*
    // against migration 0070. The lockout is consulted on the successful-
    // password path of all three login routes, so a column that does not
    // exist here is an HTTP 500 on every correct credential.
    const email = "column-check@example.com";

    const clean = await checkAuthLockout("tenant_password", email, PASSWORD_LOCKOUT_POLICY);
    expect(clean).toEqual({ locked: false, failedCount: 0, lockedUntil: null });

    for (let i = 0; i < PASSWORD_LOCKOUT_POLICY.threshold - 1; i += 1) {
      await recordAuthFailure("tenant_password", email);
    }
    const belowThreshold = await checkAuthLockout("tenant_password", email, PASSWORD_LOCKOUT_POLICY);
    expect(belowThreshold.locked).toBe(false);
    expect(belowThreshold.failedCount).toBe(PASSWORD_LOCKOUT_POLICY.threshold - 1);

    await recordAuthFailure("tenant_password", email);
    const atThreshold = await checkAuthLockout("tenant_password", email, PASSWORD_LOCKOUT_POLICY);
    expect(atThreshold.locked).toBe(true);
    expect(atThreshold.lockedUntil).not.toBeNull();

    // An explicit unlock breaks the streak the same way a success does.
    await clearAuthLockout("tenant_password", email);
    const unlocked = await checkAuthLockout("tenant_password", email, PASSWORD_LOCKOUT_POLICY);
    expect(unlocked.locked).toBe(false);
  });

  it("stores a peppered identity key, never the raw email", async () => {
    const email = "pepper@example.com";
    await recordAuthFailure("directory", email);

    const { rows } = await query<{ identity_key: string; outcome: string }>(
      `SELECT identity_key, outcome FROM auth_login_attempts WHERE realm = 'directory'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("failed");
    expect(rows[0].identity_key).not.toContain(email);
    expect(rows[0].identity_key).toMatch(/^[0-9a-f]{64}$/);
  });
});
