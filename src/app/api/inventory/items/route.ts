import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { getPrimaryLocation } from "@/lib/setup-state";

export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: {
    name?: string;
    unit?: string;
    sku?: string;
    reorderLevel?: number | null;
    purchaseUnit?: string | null;
    purchaseUnitFactor?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  const unit = body.unit?.trim();
  if (!name || !unit) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const reorderLevel =
    body.reorderLevel === undefined || body.reorderLevel === null ? null : Number(body.reorderLevel);
  if (reorderLevel !== null && (!Number.isFinite(reorderLevel) || reorderLevel < 0)) {
    return NextResponse.json({ error: "invalid_reorder_level" }, { status: 400 });
  }
  const purchaseUnitFactor = body.purchaseUnitFactor === undefined ? 1 : Number(body.purchaseUnitFactor);
  if (!Number.isFinite(purchaseUnitFactor) || purchaseUnitFactor <= 0) {
    return NextResponse.json({ error: "invalid_purchase_unit_factor" }, { status: 400 });
  }

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows } = await query<{ id: string }>(
    `INSERT INTO inventory_items (location_id, name, sku, unit, reorder_level, purchase_unit, purchase_unit_factor)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      location.id,
      name,
      body.sku?.trim() || null,
      unit,
      reorderLevel,
      body.purchaseUnit?.trim() || null,
      purchaseUnitFactor,
    ],
  );
  return NextResponse.json({ ok: true, id: rows[0].id });
}
