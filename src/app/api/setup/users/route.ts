import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { query } from "@/lib/db";
import { markStepDone } from "@/lib/settings";
import { getPrimaryLocation, requireManager } from "@/lib/setup-state";
import type { Role } from "@/lib/auth";

/** Step 5 — roles & initial users (owner already exists from bootstrap/seed). */
export async function GET() {
  const { session, error } = await requireManager();
  if (error) return error;

  const { rows: users } = await query(
    `SELECT id, role, full_name, email, is_active,
            (pin_hash IS NOT NULL) AS has_pin
       FROM users WHERE business_id = $1
      ORDER BY created_at`,
    [session.businessId],
  );
  return NextResponse.json({ users });
}

const PIN_ROLES: Role[] = ["cashier", "waiter", "kitchen"];

export async function POST(request: NextRequest) {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: { role?: Role; fullName?: string; email?: string; password?: string; pin?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const role = body.role;
  const fullName = body.fullName?.trim();
  if (!fullName || !role || !["manager", ...PIN_ROLES].includes(role)) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  if (role === "manager") {
    const email = body.email?.trim().toLowerCase();
    const password = body.password ?? "";
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "invalid_email" }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "weak_password" }, { status: 400 });
    }
    const { rows: dup } = await query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (dup.length > 0) {
      return NextResponse.json({ error: "email_taken" }, { status: 409 });
    }
    await query(
      `INSERT INTO users (business_id, role, full_name, email, password_hash)
       VALUES ($1, 'manager', $2, $3, $4)`,
      [session.businessId, fullName, email, await bcrypt.hash(password, 10)],
    );
  } else {
    const pin = body.pin ?? "";
    if (!/^\d{4}$/.test(pin)) {
      return NextResponse.json({ error: "invalid_pin" }, { status: 400 });
    }
    const location = await getPrimaryLocation(session.businessId);
    if (!location) {
      return NextResponse.json({ error: "no_location" }, { status: 409 });
    }
    // PINs are bcrypt-hashed, so uniqueness-per-location is enforced here, not in the DB.
    const { rows: peers } = await query<{ pin_hash: string }>(
      `SELECT pin_hash FROM users
        WHERE location_id = $1 AND is_active AND pin_hash IS NOT NULL`,
      [location.id],
    );
    for (const peer of peers) {
      if (await bcrypt.compare(pin, peer.pin_hash)) {
        return NextResponse.json({ error: "pin_taken" }, { status: 409 });
      }
    }
    await query(
      `INSERT INTO users (business_id, location_id, role, full_name, pin_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [session.businessId, location.id, role, fullName, await bcrypt.hash(pin, 10)],
    );
  }

  const progress = await markStepDone(session.businessId, "users");
  return NextResponse.json({ ok: true, progress });
}
