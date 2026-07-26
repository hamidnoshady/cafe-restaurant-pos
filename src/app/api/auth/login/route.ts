import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query, withoutTenantScope } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import {
  membershipBlockedReason,
  membershipsForPlatformUser,
  type Membership,
} from "@/lib/memberships";

interface PlatformUserRow extends Record<string, unknown> {
  id: string;
  full_name: string;
  password_hash: string;
  is_active: boolean;
}

/** A bcrypt hash of nothing in particular, used to keep timing uniform. */
const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

function sessionFor(membership: Membership, platformUserId: string) {
  return signSession({
    sub: membership.userId,
    role: membership.role,
    businessId: membership.businessId,
    locationId: membership.locationId,
    fullName: membership.fullName,
    platformUserId,
  });
}

/**
 * Email + password login.
 *
 * Since Phase 12 an email identifies a *person*, not a user of one business,
 * so this resolves the identity first and then their memberships:
 *
 *   - exactly one usable membership → signed straight in, as before;
 *   - several → 200 carrying `businesses` and no cookie; the client posts back
 *     with the chosen `businessId`;
 *   - none usable → 403 saying why (suspended business, or no membership).
 *
 * The whole handler runs bypassed: "which businesses does this email belong
 * to" is necessarily a cross-tenant question, asked before any business has
 * been chosen. It is one of the two documented holes in the isolation boundary
 * — see `withoutTenantScope` in src/lib/db.ts.
 */
export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string; businessId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { email, password } = body;
  if (!email || !password) {
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  return withoutTenantScope("login", async () => {
    const { rows } = await query<PlatformUserRow>(
      `SELECT id, full_name, password_hash, is_active FROM platform_users WHERE email = $1`,
      [email.trim().toLowerCase()],
    );

    // Compare against a dummy hash when the identity is missing or disabled so
    // a wrong email and a wrong password cost the same time and can't be told
    // apart by an enumeration attempt.
    const identity = rows[0];
    const usableIdentity = identity?.is_active ? identity : null;
    const passwordOk = await bcrypt.compare(password, usableIdentity?.password_hash ?? DUMMY_HASH);
    if (!usableIdentity || !passwordOk) {
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const memberships = await membershipsForPlatformUser(usableIdentity.id);
    if (memberships.length === 0) {
      return NextResponse.json({ error: "no_business_membership" }, { status: 403 });
    }

    const usable = memberships.filter((m) => membershipBlockedReason(m) === null);
    if (usable.length === 0) {
      return NextResponse.json(
        { error: "business_unavailable", reason: membershipBlockedReason(memberships[0]) },
        { status: 403 },
      );
    }

    const chosen = body.businessId
      ? usable.find((m) => m.businessId === body.businessId)
      : usable.length === 1
        ? usable[0]
        : undefined;

    if (!chosen) {
      return NextResponse.json({
        needsBusinessSelection: true,
        businesses: usable.map((m) => ({
          id: m.businessId,
          name: m.businessName,
          slug: m.businessSlug,
          role: m.role,
        })),
      });
    }

    await query(`UPDATE platform_users SET last_login_at = now() WHERE id = $1`, [
      usableIdentity.id,
    ]);

    const res = NextResponse.json({
      user: { id: chosen.userId, role: chosen.role, fullName: chosen.fullName },
      business: { id: chosen.businessId, name: chosen.businessName, slug: chosen.businessSlug },
    });
    res.cookies.set(
      SESSION_COOKIE,
      await sessionFor(chosen, usableIdentity.id),
      sessionCookieOptions(),
    );
    return res;
  });
}
