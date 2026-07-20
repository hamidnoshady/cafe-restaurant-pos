import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query } from "@/lib/db";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  signSession,
  type Role,
} from "@/lib/auth";

interface UserRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  role: Role;
  full_name: string;
  password_hash: string | null;
}

/** Email + password login for Owner/Manager. */
export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { email, password } = body;
  if (!email || !password) {
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  const { rows } = await query<UserRow>(
    `SELECT id, business_id, location_id, role, full_name, password_hash
       FROM users
      WHERE email = $1 AND is_active AND role IN ('owner', 'manager')`,
    [email],
  );

  const user = rows[0];
  if (!user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
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
