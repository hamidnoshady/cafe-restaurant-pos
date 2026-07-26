import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import {
  MissingLedgerAccountError,
  postExactPurchaseEntry,
  postNegativeStockSettlementEntry,
} from "@/lib/ledger-service";
import { positiveQuantityText, rialText } from "@/lib/inventory-exact";
import { applyPurchaseReceiptCosting } from "@/lib/purchase-receipt-costing";
import { resolveActiveLocation } from "@/lib/setup-state";

const SETTLEMENT_METHODS = ["cash", "bank", "credit"] as const;
type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { rows: header } = await query(
    `SELECT p.*, s.name AS supplier_name FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id AND s.location_id = p.location_id
      WHERE p.id = $1 AND p.location_id = $2`,
    [id, location.id],
  );
  if (!header[0]) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { rows: items } = await query(
    `SELECT pi.id, pi.inventory_item_id, ii.name AS inventory_item_name, ii.unit, pi.quantity, pi.unit_cost
       FROM purchase_items pi JOIN inventory_items ii ON ii.id = pi.inventory_item_id
      WHERE pi.purchase_id = $1 AND ii.location_id = $2
        AND EXISTS (SELECT 1 FROM purchases p WHERE p.id=pi.purchase_id AND p.location_id=$2)`,
    [id, location.id],
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

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { status?: string; settlementMethod?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const nextStatus = body.status;
  if (!nextStatus) return NextResponse.json({ error: "invalid_transition" }, { status: 409 });

  // received: increases stock, (weighted-average) rolls avg_cost forward, and
  // posts the Phase 7 journal entry (Debit Inventory / Credit AP or Cash/Bank).
  const settlementMethod: SettlementMethod = SETTLEMENT_METHODS.includes(body.settlementMethod as SettlementMethod)
    ? (body.settlementMethod as SettlementMethod)
    : "credit";

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: locked } = await client.query<{ id:string; status:string; total:string }>(
      "SELECT id,status,total FROM purchases WHERE id=$1 AND location_id=$2 FOR UPDATE", [id, location.id]);
    const purchase = locked[0];
    if (!purchase) { await client.query("ROLLBACK"); return NextResponse.json({ error:"not_found" }, { status:404 }); }
    if (!(VALID_TRANSITIONS[purchase.status] ?? []).includes(nextStatus)) {
      await client.query("ROLLBACK"); return NextResponse.json({ error:"invalid_transition" }, { status:409 });
    }
    if (nextStatus !== "received") {
      await client.query(`UPDATE purchases SET status=$2, ordered_at=CASE WHEN $2='ordered' THEN now() ELSE ordered_at END WHERE id=$1`, [id,nextStatus]);
      await client.query("COMMIT"); return NextResponse.json({ok:true});
    }
    const { rows: items } = await client.query<{
      id:string; inventory_item_id:string; quantity:string; extended_cost:string;
    }>(
      `SELECT id,inventory_item_id,quantity::text,extended_cost::text
         FROM purchase_items WHERE purchase_id=$1 ORDER BY inventory_item_id,id`, [id]);
    const { rows: eventRows } = await client.query<{id:string}>(
      `INSERT INTO inventory_events
         (business_id,location_id,event_type,source_type,source_id,created_by,costing_version)
       VALUES($1,$2,'purchase_receipt','purchase',$3,$4,2) RETURNING id`,
      [session.businessId,location.id,id,session.sub]);
    const eventId=eventRows[0].id;
    const costing = await applyPurchaseReceiptCosting(
      client,
      {
        locationId: location.id,
        businessId: session.businessId,
        purchaseId: id,
        inventoryEventId: eventId,
        createdBy: session.sub,
        items: items.map((item) => ({
          purchaseItemId: item.id,
          inventoryItemId: item.inventory_item_id,
          quantity: positiveQuantityText(item.quantity),
          extendedCost: rialText(item.extended_cost),
        })),
      },
    );
    if (costing.receiptValue !== rialText(purchase.total)) throw new Error("purchase_total_mismatch");
    await client.query(
      "UPDATE purchases SET status = 'received', received_at = now(), settlement_method = $2 WHERE id = $1",
      [id, settlementMethod],
    );
    await postExactPurchaseEntry(client, {
      businessId: session.businessId,
      locationId: location.id,
      purchaseId: id,
      createdBy: session.sub,
      total: costing.receiptValue,
      settlementMethod,
      inventoryEventId: eventId,
    });
    await postNegativeStockSettlementEntry(client, {
      businessId: session.businessId,
      locationId: location.id,
      purchaseId: id,
      createdBy: session.sub,
      upward: costing.upwardSettlementAdjustment,
      downward: costing.downwardSettlementAdjustment,
      inventoryEventId: eventId,
    });
    await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [eventId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    throw err;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true });
}
