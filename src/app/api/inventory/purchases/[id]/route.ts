import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { receivePurchase } from "@/lib/inventory-service";
import { MissingLedgerAccountError, postPurchaseEntry } from "@/lib/ledger-service";
import { getPrimaryLocation } from "@/lib/setup-state";

const SETTLEMENT_METHODS = ["cash", "bank", "credit"] as const;
type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

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
    const { rows: items } = await client.query<{ inventory_item_id:string; quantity:string; unit_cost:string }>(
      "SELECT inventory_item_id,quantity,unit_cost FROM purchase_items WHERE purchase_id=$1 ORDER BY inventory_item_id", [id]);
    const { rows: eventRows } = await client.query<{id:string}>(
      `INSERT INTO inventory_events(business_id,location_id,event_type,source_type,source_id,created_by)
       VALUES($1,$2,'purchase_receipt','purchase',$3,$4) RETURNING id`, [session.businessId,location.id,id,session.sub]);
    const eventId=eventRows[0].id;
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
      eventId,
    );
    await client.query(
      "UPDATE purchases SET status = 'received', received_at = now(), settlement_method = $2 WHERE id = $1",
      [id, settlementMethod],
    );
    await postPurchaseEntry(client, {
      businessId: session.businessId,
      locationId: location.id,
      purchaseId: id,
      createdBy: session.sub,
      total: Number(purchase.total),
      settlementMethod,
    });
    await client.query("UPDATE journal_entries SET inventory_event_id=$2 WHERE source_type='purchase' AND source_id=$1", [id,eventId]);
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
