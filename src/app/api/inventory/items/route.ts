import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: {
    name?: string;
    unit?: string;
    sku?: string | null;
    reorderLevel?: number | null;
    purchaseUnit?: string | null;
    purchaseUnitFactor?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const unit = typeof body.unit === "string" ? body.unit.trim() : "";
  if (!name || !unit) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (
    (body.sku !== undefined && body.sku !== null && typeof body.sku !== "string") ||
    (body.purchaseUnit !== undefined && body.purchaseUnit !== null && typeof body.purchaseUnit !== "string")
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const reorderLevel =
    body.reorderLevel === undefined || body.reorderLevel === null ? null : Number(body.reorderLevel);
  if (reorderLevel !== null && (!Number.isFinite(reorderLevel) || reorderLevel < 0)) {
    return NextResponse.json({ error: "invalid_reorder_level" }, { status: 400 });
  }
  const purchaseUnitFactor = body.purchaseUnitFactor === undefined ? 1 : Number(body.purchaseUnitFactor);
  if (!Number.isFinite(purchaseUnitFactor) || purchaseUnitFactor <= 0) {
    return NextResponse.json({ error: "invalid_purchase_unit_factor" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
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
});
