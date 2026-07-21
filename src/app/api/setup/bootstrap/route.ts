import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getPool } from "@/lib/db";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { hasAnyUser } from "@/lib/setup-state";

/**
 * First-run bootstrap: on a completely empty database, creates the business,
 * its first location, and the Owner account in one step, then signs the Owner
 * in so the wizard can continue. Public route — but refuses to run as soon as
 * any user exists.
 */
export async function POST(request: NextRequest) {
  if (await hasAnyUser()) {
    return NextResponse.json({ error: "already_initialized" }, { status: 409 });
  }

  let body: {
    businessName?: string;
    locationName?: string;
    address?: string;
    phone?: string;
    ownerName?: string;
    email?: string;
    password?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const businessName = body.businessName?.trim();
  const locationName = body.locationName?.trim() || "شعبه مرکزی";
  const ownerName = body.ownerName?.trim();
  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";

  if (!businessName || !ownerName || !email || !password) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "weak_password" }, { status: 400 });
  }

  const client = await getPool().connect();
  let created: { userId: string; businessId: string };
  try {
    await client.query("BEGIN");
    // Serialize concurrent bootstraps (row locks can't help on an empty table),
    // then re-check inside the transaction.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('setup_bootstrap'))");
    const { rows: userRows } = await client.query("SELECT 1 FROM users LIMIT 1");
    if (userRows.length > 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "already_initialized" }, { status: 409 });
    }

    const biz = await client.query("INSERT INTO businesses (name) VALUES ($1) RETURNING id", [
      businessName,
    ]);
    const businessId: string = biz.rows[0].id;

    await client.query(
      "INSERT INTO locations (business_id, name, address, phone) VALUES ($1, $2, $3, $4)",
      [businessId, locationName, body.address?.trim() || null, body.phone?.trim() || null],
    );

    const user = await client.query(
      `INSERT INTO users (business_id, role, full_name, email, password_hash)
       VALUES ($1, 'owner', $2, $3, $4) RETURNING id`,
      [businessId, ownerName, email, await bcrypt.hash(password, 10)],
    );

    await client.query("COMMIT");
    created = { userId: user.rows[0].id, businessId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const token = await signSession({
    sub: created.userId,
    role: "owner",
    businessId: created.businessId,
    locationId: null,
    fullName: ownerName,
  });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
