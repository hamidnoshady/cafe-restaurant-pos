import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query, withTenant, withoutTenantScope } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession, type Role } from "@/lib/auth";
import { toLatinDigits } from "@/lib/digits";

interface UserRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  role: Role;
  full_name: string;
  pin_hash: string | null;
}

/**
 * Resolves which business a PIN is being offered to.
 *
 * Before Phase 12 this route compared the PIN against every staff member in
 * the database, which on a multi-business deployment both leaks across tenants
 * and breaks outright the first time two businesses pick the same four digits.
 * A PIN is now only ever checked within one business, identified by (in order)
 * an explicit business, the branch the device belongs to, or — on a
 * single-business install, which is what every on-premise deployment is — the
 * only business there is.
 */
async function resolveBusinessId(body: {
  businessId?: string;
  businessSlug?: string;
  locationId?: string;
}): Promise<{ businessId: string | null; error: string | null }> {
  return withoutTenantScope("login", async () => {
    if (body.businessId) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM businesses WHERE id = $1 AND status = 'active'`,
        [body.businessId],
      );
      return { businessId: rows[0]?.id ?? null, error: rows[0] ? null : "unknown_business" };
    }

    if (body.businessSlug) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM businesses WHERE slug = $1 AND status = 'active'`,
        [body.businessSlug],
      );
      return { businessId: rows[0]?.id ?? null, error: rows[0] ? null : "unknown_business" };
    }

    if (body.locationId) {
      const { rows } = await query<{ business_id: string }>(
        `SELECT l.business_id FROM locations l
           JOIN businesses b ON b.id = l.business_id
          WHERE l.id = $1 AND b.status = 'active'`,
        [body.locationId],
      );
      return {
        businessId: rows[0]?.business_id ?? null,
        error: rows[0] ? null : "unknown_location",
      };
    }

    const { rows } = await query<{ id: string }>(
      `SELECT id FROM businesses WHERE status = 'active' LIMIT 2`,
    );
    if (rows.length === 1) return { businessId: rows[0].id, error: null };
    return { businessId: null, error: rows.length === 0 ? "unknown_business" : "business_required" };
  });
}

/**
 * PIN quick-login for Cashier/Waiter/Kitchen.
 *
 * PINs are unique per business (migration 0020 moved that uniqueness down from
 * the whole table), so (business, pin) identifies one member; passing a
 * locationId narrows it further on a multi-branch business.
 */
export async function POST(request: NextRequest) {
  let body: { pin?: string; locationId?: string; businessId?: string; businessSlug?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const pin = body.pin ? toLatinDigits(String(body.pin)) : "";
  if (!/^\d{4}$/.test(pin)) {
    return NextResponse.json({ error: "invalid_pin" }, { status: 400 });
  }

  const { businessId, error } = await resolveBusinessId(body);
  if (!businessId) {
    // "Which business?" is a configuration problem, not a credential one, so
    // it gets a 400 the device can act on rather than a blanket 401.
    return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
  }

  return withTenant(businessId, async () => {
    const params: unknown[] = [];
    let locationFilter = "";
    if (body.locationId) {
      params.push(body.locationId);
      locationFilter = "AND location_id = $1";
    }

    // RLS confines this to `businessId`, which is why there is no business_id
    // predicate here — the tenant scope is the boundary being relied on.
    const { rows } = await query<UserRow>(
      `SELECT id, business_id, location_id, role, full_name, pin_hash
         FROM users
        WHERE is_active
          AND role IN ('cashier', 'waiter', 'kitchen')
          AND pin_hash IS NOT NULL
          ${locationFilter}`,
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
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const token = await signSession({
      sub: user.id,
      role: user.role,
      businessId: user.business_id,
      locationId: user.location_id,
      fullName: user.full_name,
      platformUserId: null,
    });

    const res = NextResponse.json({
      user: { id: user.id, role: user.role, fullName: user.full_name },
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  });
}
