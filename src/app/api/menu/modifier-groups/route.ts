import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { getPrimaryLocation } from "@/lib/setup-state";

export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { name?: string; minSelect?: number; maxSelect?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  const minSelect = Number.isFinite(body.minSelect) ? Number(body.minSelect) : 0;
  const maxSelect = Number.isFinite(body.maxSelect) ? Number(body.maxSelect) : 1;
  if (!name || minSelect < 0 || maxSelect < 1 || minSelect > maxSelect) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows } = await query<{ id: string }>(
    `INSERT INTO modifier_groups (location_id, name, min_select, max_select)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [location.id, name, minSelect, maxSelect],
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
}
