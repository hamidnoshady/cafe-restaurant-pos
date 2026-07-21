import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { getPrimaryLocation } from "@/lib/setup-state";

/**
 * Minimal table list for Phase 2's dine-in picker (a plain list, not a
 * floor plan — the real floor plan/map arrives in Phase 3).
 */
export async function GET() {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ tables: [] });

  const { rows: tables } = await query(
    `SELECT id, name, zone, capacity, status, sort_order FROM dining_tables
      WHERE location_id = $1 AND is_active ORDER BY sort_order, name`,
    [location.id],
  );
  return NextResponse.json({ tables });
}

export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { name?: string; zone?: string; capacity?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  const capacity = Number.isFinite(body.capacity) ? Number(body.capacity) : 2;
  if (!name || capacity <= 0) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: dup } = await query("SELECT id FROM dining_tables WHERE location_id = $1 AND name = $2", [
    location.id,
    name,
  ]);
  if (dup.length > 0) return NextResponse.json({ error: "table_exists" }, { status: 409 });

  const { rows } = await query<{ id: string }>(
    `INSERT INTO dining_tables (location_id, name, zone, capacity, sort_order)
     SELECT $1, $2, $3, $4, COALESCE(MAX(sort_order) + 1, 0)
       FROM dining_tables WHERE location_id = $1
     RETURNING id`,
    [location.id, name, body.zone?.trim() || null, capacity],
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
}
