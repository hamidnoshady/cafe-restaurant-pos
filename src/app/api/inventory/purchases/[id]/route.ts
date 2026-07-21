import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { receivePurchase } from "@/lib/inventory-service";
import { getPrimaryLocation } from "@/lib/setup-state";

async function loadPurchase(locationId: string, id: string) {
  const { rows } = await query<{ id: string; status: string }>(
    "SELECT id, status FROM purchases WHERE id = $1 AND location_id = $2",
    [id, locationId],
  );
  return rows[0] ?? null;
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const purchase = await loadPurchase(location.id, id);
  if (!purchase) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { rows: header } = await query(
    `SELECT p.*, s.name AS supplier_name FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1`,
    [id],
  );
  const { rows: items } = await query(
    `SELECT pi.id, pi.inventory_item_id, ii.name AS inventory_item_name, ii.unit, pi.quantity, pi.unit_cost
       FROM purchase_items pi JOIN inventory_items ii ON ii.id = pi.inventory_item_id
      WHERE pi.purchase_id = $1`,
    [id],
  );
  return NextResponse.json({ purchase: header[0], items });
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["ordered", "received", "cancelled"],
  ordered: ["received", "cancelled"],
  received: [],
  cancelled: [],
};

/** Status transitions: draft -> ordered (optional formal PO step) -> received, or straight to received/cancelled. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const purchase = await loadPurchase(location.id, id);
  if (!purchase) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const nextStatus = body.status;
  const allowed = VALID_TRANSITIONS[purchase.status] ?? [];
  if (!nextStatus || !allowed.includes(nextStatus)) {
    return NextResponse.json({ error: "invalid_transition" }, { status: 409 });
  }

  if (nextStatus === "cancelled") {
    await query("UPDATE purchases SET status = 'cancelled' WHERE id = $1", [id]);
    return NextResponse.json({ ok: true });
  }

  if (nextStatus === "ordered") {
    await query("UPDATE purchases SET status = 'ordered', ordered_at = now() WHERE id = $1", [id]);
    return NextResponse.json({ ok: true });
  }

  // received: increases stock and (weighted-average) rolls avg_cost forward.
  const { rows: items } = await query<{ inventory_item_id: string; quantity: string; unit_cost: string }>(
    "SELECT inventory_item_id, quantity, unit_cost FROM purchase_items WHERE purchase_id = $1",
    [id],
  );

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await receivePurchase(
      client,
      location.id,
      session.businessId,
      id,
      items.map((i) => ({
        inventoryItemId: i.inventory_item_id,
        quantity: Number(i.quantity),
        unitCost: Number(i.unit_cost),
      })),
      session.sub,
    );
    await client.query("UPDATE purchases SET status = 'received', received_at = now() WHERE id = $1", [id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true });
}
