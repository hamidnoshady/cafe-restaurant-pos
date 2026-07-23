import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { applyStockAdjustment, getCurrentStock } from "@/lib/inventory-service";
import { getPrimaryLocation } from "@/lib/setup-state";
import { MissingLedgerAccountError, postStockCountEntry } from "@/lib/ledger-service";

export async function GET() {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ counts: [] });

  const { rows: counts } = await query(
    `SELECT sc.id, sc.note, sc.counted_at, u.full_name AS counted_by_name,
            (SELECT count(*) FROM stock_count_lines WHERE stock_count_id = sc.id) AS line_count
       FROM stock_counts sc LEFT JOIN users u ON u.id = sc.counted_by
      WHERE sc.location_id = $1 ORDER BY sc.counted_at DESC LIMIT 50`,
    [location.id],
  );
  return NextResponse.json({ counts });
}

interface CountLineInput {
  inventoryItemId?: string;
  countedQty?: number;
}

/**
 * Ad hoc physical count entry: for each line, the counted quantity is
 * compared against system stock at the moment of counting and the
 * difference is posted as an 'adjustment' stock movement (see
 * applyStockAdjustment) so on-hand stock matches reality going forward.
 */
export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { note?: string; lines?: CountLineInput[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const lines = body.lines ?? [];
  if (lines.length === 0) return NextResponse.json({ error: "no_items" }, { status: 400 });
  for (const l of lines) {
    if (!l.inventoryItemId || !Number.isFinite(Number(l.countedQty)) || Number(l.countedQty) < 0) {
      return NextResponse.json({ error: "invalid_item" }, { status: 400 });
    }
  }

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const itemIds = lines.map((l) => l.inventoryItemId);
  const { rows: owned } = await query(
    "SELECT id FROM inventory_items WHERE id = ANY($1::uuid[]) AND location_id = $2",
    [itemIds, location.id],
  );
  if (owned.length !== new Set(itemIds).size) {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // One deterministic lock acquisition prevents count/sale/purchase deadlocks.
    await client.query("SELECT id FROM inventory_items WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [itemIds]);
    const { rows: countRows } = await client.query<{ id: string }>(
      "INSERT INTO stock_counts (location_id, note, counted_by) VALUES ($1, $2, $3) RETURNING id",
      [location.id, body.note?.trim() || null, session.sub],
    );
    const stockCountId = countRows[0].id;
    const { rows: eventRows } = await client.query<{ id: string }>(
      `INSERT INTO inventory_events(business_id,location_id,event_type,source_type,source_id,created_by,idempotency_key)
       VALUES($1,$2,'stock_count_adjustment','stock_count',$3,$4,'stock-count:' || $3) RETURNING id`,
      [session.businessId, location.id, stockCountId, session.sub]);
    const eventId = eventRows[0].id;
    await client.query("UPDATE stock_counts SET inventory_event_id=$2 WHERE id=$1", [stockCountId,eventId]);

    let shortageValue = 0;
    let surplusValue = 0;
    for (const l of [...lines].sort((a,b) => lId(a).localeCompare(lId(b)))) {
      const inventoryItemId = l.inventoryItemId!;
      const countedQty = Number(l.countedQty);
      const systemQty = await getCurrentStock(client, inventoryItemId);
      const variance = countedQty - systemQty;

      const varianceValue = await applyStockAdjustment(client, {
        locationId: location.id,
        businessId: session.businessId,
        inventoryItemId,
        delta: variance,
        sourceType: "stock_count",
        sourceId: stockCountId,
        createdBy: session.sub,
        inventoryEventId: eventId,
      });
      if (varianceValue < 0) shortageValue += Math.abs(varianceValue);
      else surplusValue += varianceValue;
      const unitCost = variance === 0 ? 0 : Math.abs(varianceValue / variance);
      await client.query(
        `INSERT INTO stock_count_lines (stock_count_id, inventory_item_id, system_qty, counted_qty, variance, unit_carrying_cost, variance_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [stockCountId, inventoryItemId, systemQty, countedQty, variance, unitCost, varianceValue],
      );
    }

    await postStockCountEntry(client, { businessId: session.businessId, locationId: location.id,
      stockCountId, inventoryEventId: eventId, createdBy: session.sub, shortageValue, surplusValue });
    await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [eventId]);

    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id: stockCountId });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    throw err;
  } finally {
    client.release();
  }
}

function lId(line: CountLineInput): string { return line.inventoryItemId ?? ""; }
