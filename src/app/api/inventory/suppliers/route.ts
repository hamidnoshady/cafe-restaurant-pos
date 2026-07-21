import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { getPrimaryLocation } from "@/lib/setup-state";

export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { name?: string; phone?: string; notes?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows } = await query<{ id: string }>(
    "INSERT INTO suppliers (location_id, name, phone, notes) VALUES ($1, $2, $3, $4) RETURNING id",
    [location.id, name, body.phone?.trim() || null, body.notes?.trim() || null],
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
}
