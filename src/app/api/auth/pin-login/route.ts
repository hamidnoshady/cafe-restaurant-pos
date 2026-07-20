import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query } from "@/lib/db";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  signSession,
  type Role,
} from "@/lib/auth";
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
 * PIN quick-login for Cashier/Waiter/Kitchen.
 * PINs are unique per location, so (locationId, pin) identifies one user;
 * without locationId (single-location setups) all staff are checked.
 */
export async function POST(request: NextRequest) {
  let body: { pin?: string; locationId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const pin = body.pin ? toLatinDigits(String(body.pin)) : "";
  if (!/^\d{4}$/.test(pin)) {
    return NextResponse.json({ error: "invalid_pin" }, { status: 400 });
  }

  const params: unknown[] = [];
  let locationFilter = "";
  if (body.locationId) {
    params.push(body.locationId);
    locationFilter = "AND location_id = $1";
  }

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
  });

  const res = NextResponse.json({
    user: { id: user.id, role: user.role, fullName: user.full_name },
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
