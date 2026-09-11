import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { positiveQuantityText } from "@/lib/inventory-exact";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isWasteReason, recordWaste } from "@/lib/waste-service";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ entries: [] });

  const { rows } = await query(
    `SELECT sm.id, sm.inventory_item_id, ii.name AS inventory_item_name, ii.unit,
            -sm.quantity AS quantity, sm.unit_cost, sm.waste_reason, sm.note, sm.occurred_at
       FROM stock_movements sm JOIN inventory_items ii ON ii.id = sm.inventory_item_id
      WHERE sm.location_id = $1 AND sm.type = 'waste'
      ORDER BY sm.occurred_at DESC LIMIT 100`,
    [location.id],
  );
  return NextResponse.json({ entries: rows });
});

/**
 * Logs shrinkage: reduces stock without touching sales figures (separate from
 * order deduction). The posting itself lives in `waste-service.ts` because the
 * coworker's `inventory.waste.log` executor runs the identical write with no
 * request to hang a session on — see Phase 32.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { inventoryItemId?: string; quantity?: number | string; reason?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Accept the quantity as text so a caller can send more precision than an
  // IEEE-754 double carries; `positiveQuantityText` is the validator.
  let quantity;
  try {
    quantity = positiveQuantityText(String(body.quantity ?? ""));
  } catch {
    return NextResponse.json({ error: "invalid_item" }, { status: 400 });
  }
  if (!body.inventoryItemId) {
    return NextResponse.json({ error: "invalid_item" }, { status: 400 });
  }
  if (!isWasteReason(body.reason)) {
    return NextResponse.json({ error: "invalid_waste_reason" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: item } = await query(
    "SELECT id FROM inventory_items WHERE id = $1 AND location_id = $2",
    [body.inventoryItemId, location.id],
  );
  if (item.length === 0) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  try {
    const recorded = await recordWaste({
      businessId: session.businessId,
      locationId: location.id,
      inventoryItemId: body.inventoryItemId,
      quantity,
      reason: body.reason,
      note: body.note?.trim() || null,
      createdBy: session.sub,
    });
    return NextResponse.json({ ok: true, totalCost: recorded.postedCost });
  } catch (err) {
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    if (err instanceof Error && err.message === "periodic_system_unsupported") {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
});
