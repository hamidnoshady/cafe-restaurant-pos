import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { convertPurchaseQuantity } from "@/lib/inventory";
import { getPrimaryLocation } from "@/lib/setup-state";

/** Recent purchases, newest first (headers only — GET /api/inventory/purchases/[id] has line items). */
export async function GET() {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ purchases: [] });

  const { rows } = await query(
    `SELECT p.id, p.status, p.total, p.note, p.ordered_at, p.received_at, p.created_at,
            s.name AS supplier_name
       FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.location_id = $1 ORDER BY p.created_at DESC LIMIT 100`,
    [location.id],
  );
  return NextResponse.json({ purchases: rows });
}

interface PurchaseItemInput {
  inventoryItemId?: string;
  /** quantity in the item's purchase_unit (or base unit if none is set) */
  purchaseQty?: number;
  /** total Rial cost for this line (however the supplier invoiced it) */
  totalCost?: number;
}

/**
 * Creates a draft purchase. Each line's purchaseQty is entered in the
 * item's purchase unit (e.g. kg) and converted here to its base/recipe
 * unit (e.g. g) via purchase_unit_factor, so purchase_items/stock_movements
 * always store one unit per item — see migrations/0006_inventory.sql.
 * unit_cost is derived from the line's total cost, not entered directly,
 * since suppliers invoice by the purchased quantity, not the base unit.
 */
export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { supplierId?: string | null; note?: string; items?: PurchaseItemInput[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const items = body.items ?? [];
  if (items.length === 0) return NextResponse.json({ error: "no_items" }, { status: 400 });
  for (const it of items) {
    if (
      !it.inventoryItemId ||
      !Number.isFinite(Number(it.purchaseQty)) ||
      Number(it.purchaseQty) <= 0 ||
      !Number.isSafeInteger(Number(it.totalCost)) ||
      Number(it.totalCost) < 0
    ) {
      return NextResponse.json({ error: "invalid_item" }, { status: 400 });
    }
  }

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const inventoryItemIds = items.map((i) => i.inventoryItemId);
  const { rows: invItems } = await query<{ id: string; purchase_unit_factor: string }>(
    "SELECT id, purchase_unit_factor FROM inventory_items WHERE id = ANY($1::uuid[]) AND location_id = $2",
    [inventoryItemIds, location.id],
  );
  const factorById = new Map(invItems.map((i) => [i.id, Number(i.purchase_unit_factor)]));
  if (invItems.length !== new Set(inventoryItemIds).size) {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }

  if (body.supplierId) {
    const { rows: supplier } = await query(
      "SELECT id FROM suppliers WHERE id = $1 AND location_id = $2",
      [body.supplierId, location.id],
    );
    if (supplier.length === 0) return NextResponse.json({ error: "supplier_not_found" }, { status: 404 });
  }

  const lines = items.map((it) => {
    const factor = factorById.get(it.inventoryItemId!)!;
    const baseQty = convertPurchaseQuantity(Number(it.purchaseQty), factor);
    const totalCost = Number(it.totalCost);
    return { inventoryItemId: it.inventoryItemId!, baseQty, totalCost };
  });
  const totalBigInt = lines.reduce((sum, l) => sum + BigInt(l.totalCost), 0n);
  if (totalBigInt > BigInt(Number.MAX_SAFE_INTEGER)) return NextResponse.json({ error: "amount_too_large" }, { status: 400 });
  const total = totalBigInt.toString();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: purchaseRows } = await client.query<{ id: string }>(
      `INSERT INTO purchases (location_id, supplier_id, status, total, note, created_by)
       VALUES ($1, $2, 'draft', $3, $4, $5) RETURNING id`,
      [location.id, body.supplierId || null, total, body.note?.trim() || null, session.sub],
    );
    const purchaseId = purchaseRows[0].id;
    for (const line of lines) {
      await client.query(
        `INSERT INTO purchase_items (purchase_id, inventory_item_id, quantity, unit_cost, extended_cost)
         VALUES ($1, $2, $3, $4::numeric / $3::numeric, $4)`,
        [purchaseId, line.inventoryItemId, String(line.baseQty), String(line.totalCost)],
      );
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id: purchaseId, total });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
