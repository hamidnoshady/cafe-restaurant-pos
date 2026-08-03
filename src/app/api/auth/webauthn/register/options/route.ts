import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { beginWebauthnRegistration } from "@/lib/employee-service";

/**
 * Phase 20 Wave 3 — step 1 of registering a biometric authenticator: always
 * self-service (the caller registers their own device, never someone
 * else's), and restricted to the same PIN-role audience as the lock screen
 * and the login picker (Wave 2) — biometric is an alternative to *PIN*
 * entry, not to a password login.
 */
export const POST = withTenantScope(async () => {
  const { session, error } = await requireRole("cashier", "waiter", "kitchen");
  if (error) return error;

  const { options, challengeToken } = await beginWebauthnRegistration(
    session.sub,
    session.businessId,
    session.fullName,
  );
  return NextResponse.json({ options, challengeToken });
});
