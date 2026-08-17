import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  preparePurchaseLines,
  purchaseDateOrNull,
  PurchaseLineError,
  type PurchaseItemInput,
  type PurchaseLine,
} from "@/lib/purchase-lines";

const PURCHASE_STATUSES = ["draft", "ordered", "received", "cancelled"] as const;

/**
 * Recent purchases, newest first (headers only — GET /api/inventory/purchases/[id]
 * has line items). Optionally narrowed by status, supplier, and a purchase_date
 * range; both bounds are inclusive, since purchase_date is a plain date and the
 * caller picks a date, not an instant.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ purchases: [] });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const supplierId = searchParams.get("supplierId");
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");

  const conditions = ["p.location_id = $1"];
  const params: unknown[] = [location.id];
  if (status && (PURCHASE_STATUSES as readonly string[]).includes(status)) {
    params.push(status);
    conditions.push(`p.status = $${params.length}::purchase_status`);
  }
  if (supplierId) {
    params.push(supplierId);
    conditions.push(`p.supplier_id = $${params.length}::uuid`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`p.purchase_date >= $${params.length}::date`);
  }
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`p.purchase_date <= $${params.length}::date`);
  }

  // purchase_date as text, not as a `date` node-postgres would hand back as a
  // Date at the *server's* midnight — JSON would then shift a back-dated
  // purchase a day off for any server not running in the branch's zone.
  const { rows } = await query(
    `SELECT p.id, p.status, p.total, p.note, p.supplier_id, p.ordered_at, p.received_at, p.created_at,
            p.purchase_date::text AS purchase_date,
            s.name AS supplier_name
       FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE ${conditions.join(" AND ")} ORDER BY p.purchase_date DESC, p.created_at DESC LIMIT 100`,
    params,
  );
  return NextResponse.json({ purchases: rows });
});

/**
 * Creates a draft purchase. Line validation, ownership checks, and the
 * purchase-unit -> base-unit conversion live in preparePurchaseLines so the
 * edit path (PUT /api/inventory/purchases/[id]) behaves identically.
 * unit_cost is derived from the line's total cost, not entered directly,
 * since suppliers invoice by the purchased quantity, not the base unit.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { supplierId?: string | null; note?: string; purchaseDate?: string | null; items?: PurchaseItemInput[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  if (body.supplierId) {
    const { rows: supplier } = await query(
      "SELECT id FROM suppliers WHERE id = $1 AND location_id = $2",
      [body.supplierId, location.id],
    );
    if (supplier.length === 0) return NextResponse.json({ error: "supplier_not_found" }, { status: 404 });
  }

  let lines: PurchaseLine[];
  let total: string;
  let purchaseDate: string | null;
  try {
    purchaseDate = purchaseDateOrNull(body.purchaseDate);
    ({ lines, total } = await preparePurchaseLines(body.items ?? [], location.id));
  } catch (err) {
    if (err instanceof PurchaseLineError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // No date entered means today *at the branch*, not at the server — the
    // column's CURRENT_DATE default would be the wrong day for the hours the
    // two disagree (up to 03:30 in Asia/Tehran on a UTC server) — and "today"
    // is the branch's business day, so a delivery signed for at 01:00 during a
    // night service is dated the day that service belongs to rather than the
    // one the wall clock had just rolled into. Still only a default: the date
    // is the user's to set.
    const { rows: purchaseRows } = await client.query<{ id: string }>(
      `INSERT INTO purchases (location_id, supplier_id, status, total, note, purchase_date, created_by)
       VALUES ($1, $2, 'draft', $3, $4,
               COALESCE($5::date, (SELECT app_business_date(now(), l.timezone, l.business_day_start_minutes)
                                     FROM locations l WHERE l.id = $1)),
               $6) RETURNING id`,
      [location.id, body.supplierId || null, total, body.note?.trim() || null, purchaseDate, session.sub],
    );
    const purchaseId = purchaseRows[0].id;
    for (const line of lines) {
      await client.query(
        `INSERT INTO purchase_items (purchase_id, inventory_item_id, quantity, unit_cost, extended_cost)
         VALUES ($1, $2, $3, $4::numeric / $3::numeric, $4)`,
        [purchaseId, line.inventoryItemId, line.baseQty, line.totalCost],
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
});
