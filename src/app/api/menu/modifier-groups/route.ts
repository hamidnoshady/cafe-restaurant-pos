import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { DEFAULT_SELECTION_BOUNDS, resolveSelectionBounds } from "@/lib/modifier-selection";
import { resolveActiveLocation } from "@/lib/setup-state";

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { name?: string; minSelect?: unknown; maxSelect?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  const bounds = resolveSelectionBounds(DEFAULT_SELECTION_BOUNDS, body);
  if (!name || !bounds) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows } = await query<{ id: string }>(
    `INSERT INTO modifier_groups (location_id, name, min_select, max_select)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [location.id, name, bounds.min, bounds.max],
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
});
