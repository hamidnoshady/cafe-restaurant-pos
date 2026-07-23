import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { consumeInventory } from "@/lib/inventory-service";
import { MissingLedgerAccountError, postWasteEntry } from "@/lib/ledger-service";
import { getPrimaryLocation } from "@/lib/setup-state";

const WASTE_REASONS = ["spoilage", "prep_error", "customer_return", "staff_meal", "other"] as const;

export async function GET() {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await getPrimaryLocation(session.businessId);
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
}

/** Logs shrinkage: reduces stock without touching sales figures (separate from order deduction). */
export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { inventoryItemId?: string; quantity?: number; reason?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const quantity = Number(body.quantity);
  const reason = body.reason;
  if (!body.inventoryItemId || !Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: "invalid_item" }, { status: 400 });
  }
  if (!reason || !WASTE_REASONS.includes(reason as (typeof WASTE_REASONS)[number])) {
    return NextResponse.json({ error: "invalid_waste_reason" }, { status: 400 });
  }

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: item } = await query(
    "SELECT id FROM inventory_items WHERE id = $1 AND location_id = $2",
    [body.inventoryItemId, location.id],
  );
  if (item.length === 0) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: events } = await client.query<{id:string}>(
      `INSERT INTO inventory_events(business_id,location_id,event_type,source_type,created_by,metadata)
       VALUES($1,$2,'waste','waste',$3,jsonb_build_object('reason',$4::text)) RETURNING id`,
      [session.businessId,location.id,session.sub,reason]);
    const eventId=events[0].id;
    await client.query("UPDATE inventory_events SET source_id=id WHERE id=$1",[eventId]);
    const result = await consumeInventory(client, {
      locationId: location.id,
      businessId: session.businessId,
      inventoryItemId: body.inventoryItemId,
      quantity,
      type: "waste",
      sourceType: "waste",
      sourceId: eventId,
      note: body.note?.trim() || null,
      wasteReason: reason,
      createdBy: session.sub,
      inventoryEventId: eventId,
    });
    await postWasteEntry(client, {
      businessId: session.businessId,
      locationId: location.id,
      sourceId: eventId,
      createdBy: session.sub,
      totalCost: result.totalCost,
      inventoryEventId: eventId,
    });
    await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1",[eventId]);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, totalCost: result.totalCost });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    throw err;
  } finally {
    client.release();
  }
}
