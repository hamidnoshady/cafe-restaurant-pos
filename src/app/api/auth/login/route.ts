import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query, withoutTenantScope } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { hostRoutingEnabled, parseHost, rootDomain } from "@/lib/host";
import { resolveBusinessByLabel } from "@/lib/host-resolution";
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
    businessSlug: membership.businessSlug,
    businessSubdomain: membership.businessSubdomain,
    locationId: membership.locationId,
    fullName: membership.fullName,
    platformUserId,
  });
}

/**
 * Which business this origin is allowed to sign anyone into.
 *
 * `null` on an install with no root domain — a desktop or single-café install,
 * where the session simply is not host-scoped and the membership list decides.
 * Otherwise the host does: the cookie about to be minted is valid on this
 * origin and no other (see `handleHostIsolation` in src/middleware.ts), so
 * signing someone into business B on business A's host would hand them a
 * session they get bounced out of on their next click — a login loop, not a
 * login. `wrong_origin` covers the hosts that serve no tenant at all (the
 * apex, the console): there is nothing here to sign into.
 */
async function loginHostBusinessId(
  host: string | null,
): Promise<{ businessId: string | null; error: string | null }> {
  if (!hostRoutingEnabled()) return { businessId: null, error: null };

  const parsed = parseHost(host, rootDomain());
  if (parsed.kind !== "business") return { businessId: null, error: "wrong_origin" };

  const business = await resolveBusinessByLabel(parsed.label);
  if (!business || business.status !== "active") {
    return { businessId: null, error: "wrong_origin" };
  }
  return { businessId: business.businessId, error: null };
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

  // Ahead of the credential check, and no oracle: which business a hostname
  // serves is exactly what DNS and the certificate already say out loud.
  const hostScope = await loginHostBusinessId(request.headers.get("host"));
  if (hostScope.error) {
    return NextResponse.json({ error: hostScope.error }, { status: 400 });
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

    const allUsable = memberships.filter((m) => membershipBlockedReason(m) === null);
    if (allUsable.length === 0) {
      return NextResponse.json(
        { error: "business_unavailable", reason: membershipBlockedReason(memberships[0]) },
        { status: 403 },
      );
    }

    // On a business host there is one candidate at most, so a person with
    // several memberships is never asked to pick here: they sign in on each
    // business's own address, which the apex directory hands them.
    const usable = hostScope.businessId
      ? allUsable.filter((m) => m.businessId === hostScope.businessId)
      : allUsable;
    if (usable.length === 0) {
      // Membership elsewhere, none here. Deliberately the same answer as no
      // membership at all: this origin should not confirm that the account
      // exists on some other business.
      return NextResponse.json({ error: "no_business_membership" }, { status: 403 });
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
