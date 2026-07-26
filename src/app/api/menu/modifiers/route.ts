import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { groupId?: string; name?: string; priceDelta?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { groupId } = body;
  const name = body.name?.trim();
  const priceDelta = Number(body.priceDelta ?? 0);
  if (!groupId || !name || !Number.isSafeInteger(priceDelta)) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: group } = await query(
    "SELECT id FROM modifier_groups WHERE id = $1 AND location_id = $2",
    [groupId, location.id],
  );
  if (group.length === 0) return NextResponse.json({ error: "group_not_found" }, { status: 404 });

  const { rows } = await query<{ id: string }>(
    `INSERT INTO modifiers (location_id, group_id, name, price_delta, sort_order)
     SELECT $1, $2, $3, $4, COALESCE(MAX(sort_order) + 1, 0)
       FROM modifiers WHERE group_id = $2
     RETURNING id`,
    [location.id, groupId, name, priceDelta],
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
});
