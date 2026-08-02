import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query, withTenant } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession, type Role } from "@/lib/auth";
import { toLatinDigits } from "@/lib/digits";
import { resolveDeviceId } from "@/lib/device-service";
import {
  auditLoginFailure,
  checkLoginLockout,
  createSession,
  ensureEmployeeProfile,
  resolveLoginBusinessId,
} from "@/lib/employee-service";

interface UserRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  business_slug: string;
  location_id: string | null;
  role: Role;
  full_name: string;
  pin_hash: string | null;
}

/**
 * PIN quick-login for Cashier/Waiter/Kitchen.
 *
 * PINs are unique per business (migration 0020 moved that uniqueness down from
 * the whole table), so (business, pin) identifies one member; passing a
 * locationId narrows it further on a multi-branch business.
 *
 * Phase 20 Wave 2 — the redesigned login picks an employee by name first
 * (`pin-login/roster`), so `employeeId` narrows the lookup to that one row
 * instead of scanning every PIN-role member; omitting it keeps the original
 * bcrypt-scan behaviour for any caller that still only sends a PIN. Either
 * way, a successful match also mints a server-side `employee_sessions` row
 * (Wave 1) *alongside* the existing JWT — the JWT stays the bearer credential
 * in the cookie, the DB row exists so the session can be listed/revoked and
 * so a revocation takes effect immediately (see checkEmployeeSession in
 * auth.ts) rather than waiting for the JWT's own expiry.
 */
export async function POST(request: NextRequest) {
  let body: {
    pin?: string;
    employeeId?: string;
    locationId?: string;
    businessId?: string;
    businessSlug?: string;
    deviceToken?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const pin = body.pin ? toLatinDigits(String(body.pin)) : "";
  if (!/^\d{4}$/.test(pin)) {
    return NextResponse.json({ error: "invalid_pin" }, { status: 400 });
  }

  const { businessId, error } = await resolveLoginBusinessId(body);
  if (!businessId) {
    // "Which business?" is a configuration problem, not a credential one, so
    // it gets a 400 the device can act on rather than a blanket 401.
    return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
  }

  return withTenant(businessId, async () => {
    // Phase 20 Wave 8 — a picker-narrowed request already names the employee,
    // so a lockout is checked before touching the PIN at all; a bare legacy
    // scan doesn't know who it is yet and gets the same check further below,
    // once the matching row (if any) is found.
    if (body.employeeId) {
      const lockout = await checkLoginLockout(businessId, body.employeeId);
      if (lockout.locked) {
        return NextResponse.json(
          { error: "account_locked", lockedUntil: lockout.lockedUntil },
          { status: 423 },
        );
      }
    }

    const params: unknown[] = [];
    let filter = "";
    if (body.employeeId) {
      params.push(body.employeeId);
      filter = "AND u.id = $1";
    } else if (body.locationId) {
      params.push(body.locationId);
      filter = "AND u.location_id = $1";
    }

    // RLS confines this to `businessId`, which is why there is no business_id
    // predicate here — the tenant scope is the boundary being relied on.
    const { rows } = await query<UserRow>(
      `SELECT u.id, u.business_id, b.slug::text AS business_slug, u.location_id,
              u.role, u.full_name, u.pin_hash
         FROM users u
         JOIN businesses b ON b.id = u.business_id
        WHERE u.is_active
          AND u.role IN ('cashier', 'waiter', 'kitchen')
          AND u.pin_hash IS NOT NULL
          ${filter}`,
      params,
    );

    let user: UserRow | undefined;
    for (const row of rows) {
      if (row.pin_hash && (await bcrypt.compare(pin, row.pin_hash))) {
        user = row;
        break;
      }
    }

    if (!user) {
      // Phase 20 Wave 7 — visible in the new security center even though no
      // one is authenticated yet; entity_id is the attempted employeeId when
      // the Wave 2 picker narrowed the request, null for a bare legacy scan.
      await auditLoginFailure(businessId, body.employeeId ?? null, "invalid_pin");
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    // Phase 20 Wave 8 — the employeeId branch above already checked; only a
    // bare legacy scan reaches here without having checked yet, since it only
    // learns who matched by finding the right PIN.
    if (!body.employeeId) {
      const lockout = await checkLoginLockout(businessId, user.id);
      if (lockout.locked) {
        return NextResponse.json(
          { error: "account_locked", lockedUntil: lockout.lockedUntil },
          { status: 423 },
        );
      }
    }

    await ensureEmployeeProfile(user.id, user.business_id);
    const deviceLabel = request.headers.get("user-agent")?.slice(0, 120) ?? null;
    const deviceId = await resolveDeviceId(body.deviceToken, user.business_id);
    const { session: employeeSession } = await createSession(user.id, user.business_id, {
      locationId: user.location_id,
      deviceLabel,
      deviceId,
    });

    const token = await signSession({
      sub: user.id,
      role: user.role,
      businessId: user.business_id,
      businessSlug: user.business_slug,
      locationId: user.location_id,
      fullName: user.full_name,
      platformUserId: null,
      employeeSessionId: employeeSession.id,
    });

    const res = NextResponse.json({
      user: { id: user.id, role: user.role, fullName: user.full_name },
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  });
}
