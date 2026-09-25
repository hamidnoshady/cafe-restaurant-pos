import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { parseCountScanPayload, type CountScanRecord } from "@/lib/inventory-visual-profiles";

/**
 * The evidence side of the visual stock count: one row per *confirmed* camera
 * count — the number the operator approved, the method that produced it, the
 * engine's confidence, and a small photo of what was counted. Nothing here
 * posts a stock movement; the stock-counts API stays the only write path for
 * the tally (a count scan is an explanation of a tally line, not the line).
 *
 * The POST is deliberately fire-and-friendly from the client's perspective:
 * a failed evidence write must never block the count the operator already
 * confirmed, so the client applies the tally first and reports this in the
 * background.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ scans: [] });

  const { rows } = await query<CountScanRecord>(
    `SELECT s.id, s.inventory_item_id AS "inventoryItemId", i.name AS "itemName", i.unit,
            s.method, s.counted_qty AS "countedQty", s.confidence, s.boxes,
            s.image_data_url AS "imageDataUrl", s.created_at AS "createdAt",
            u.full_name AS "createdByName"
       FROM inventory_count_scans s
       JOIN inventory_items i ON i.id = s.inventory_item_id
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.location_id = $1
      ORDER BY s.created_at DESC
      LIMIT 30`,
    [location.id],
  );
  return NextResponse.json({ scans: rows });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const payload = parseCountScanPayload(body);
  if (!payload) return NextResponse.json({ error: "invalid_scan" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: items } = await query<{ id: string }>(
    "SELECT id FROM inventory_items WHERE id = $1 AND location_id = $2 AND is_active",
    [payload.inventoryItemId, location.id],
  );
  if (items.length === 0) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const { rows } = await query<{ id: string }>(
    `INSERT INTO inventory_count_scans
        (business_id, location_id, inventory_item_id, method, counted_qty, confidence, boxes, image_data_url, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      session.businessId,
      location.id,
      payload.inventoryItemId,
      payload.method,
      payload.countedQty,
      payload.confidence,
      JSON.stringify(payload.boxes),
      payload.imageDataUrl,
      session.sub,
    ],
  );
  return NextResponse.json({ ok: true, id: rows[0].id }, { status: 201 });
});
