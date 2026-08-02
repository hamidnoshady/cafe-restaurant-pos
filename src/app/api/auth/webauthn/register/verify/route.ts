import { NextRequest, NextResponse } from "next/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { completeWebauthnRegistration, EmployeeError } from "@/lib/employee-service";

/** Step 2 of registering a biometric authenticator — verifies the ceremony and stores the credential. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("cashier", "waiter", "kitchen");
  if (error) return error;

  let body: { response?: RegistrationResponseJSON; challengeToken?: string; deviceLabel?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.response || !body.challengeToken) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const credential = await completeWebauthnRegistration(
      session.sub,
      session.businessId,
      session.sub,
      body.response,
      body.challengeToken,
      body.deviceLabel?.slice(0, 32) ?? null,
    );
    return NextResponse.json({ credential });
  } catch (err) {
    if (err instanceof EmployeeError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
