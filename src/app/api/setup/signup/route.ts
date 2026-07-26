import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import {
  EmailPasswordMismatchError,
  provisionBusiness,
  publicSignupEnabled,
  validateProvisionBody,
  type ProvisionRequestBody,
} from "@/lib/business-provisioning";

/**
 * Self-service business registration.
 *
 * An email that already belongs to the platform may create a further business
 * — that is the cross-business identity case — but must supply its existing
 * password, since adding a business to an account is an action on that
 * account. `provisionBusiness` enforces it.
 */
export async function POST(request: NextRequest) {
  if (!publicSignupEnabled()) {
    return NextResponse.json({ error: "signup_disabled" }, { status: 403 });
  }

  let body: ProvisionRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const validated = validateProvisionBody(body);
  if (!validated.input) return NextResponse.json({ error: validated.error }, { status: 400 });
  const input = validated.input;

  let created;
  try {
    created = await provisionBusiness(input);
  } catch (err) {
    if (err instanceof EmailPasswordMismatchError) {
      // The email exists and the password didn't match. Deliberately the same
      // response either way would be unhelpful here — the caller is creating
      // an account, not authenticating — but it must not confirm more than
      // "these credentials don't go together".
      return NextResponse.json({ error: "email_password_mismatch" }, { status: 409 });
    }
    throw err;
  }

  const token = await signSession({
    sub: created.userId,
    role: "owner",
    businessId: created.businessId,
    locationId: null,
    fullName: input.ownerName,
    platformUserId: created.platformUserId,
  });

  const res = NextResponse.json({
    ok: true,
    business: { id: created.businessId, slug: created.businessSlug },
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
