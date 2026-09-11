import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { BranchError, createBranch } from "@/lib/branch-service";

/**
 * Phase 42 — the warehouse module's view of the business's locations.
 *
 * A warehouse (انبار) is a branch: stock, suppliers and every warehouse
 * document live per location. This endpoint is the warehouse module's front
 * door onto that — the list with per-warehouse stock statistics, and the
 * «افزودن انبار» write path, which delegates to the same `createBranch`
 * service the branches screen uses (one write path for locations).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const [{ rows: warehouses }, { rows: suppliers }] = await Promise.all([
    query<{
      id: string;
      name: string;
      address: string | null;
      phone: string | null;
      is_active: boolean;
      created_at: string;
      item_count: string;
      stock_value_rial: string;
      low_stock_count: string;
      last_movement_at: string | null;
    }>(
      `SELECT l.id, l.name, l.address, l.phone, l.is_active, l.created_at,
        (SELECT count(*) FROM inventory_items ii
          WHERE ii.location_id = l.id AND ii.is_active)::text AS item_count,
        (SELECT COALESCE(sum(v.valuation),0)::text
           FROM v_inventory_valuation v WHERE v.location_id = l.id)::text AS stock_value_rial,
        (SELECT count(*)
           FROM inventory_items ii
           JOIN (SELECT inventory_item_id, sum(quantity) AS qty
                   FROM stock_movements WHERE location_id = l.id
                  GROUP BY inventory_item_id) s
             ON s.inventory_item_id = ii.id
          WHERE ii.location_id = l.id AND ii.is_active
            AND ii.reorder_level IS NOT NULL AND s.qty <= ii.reorder_level
        )::text AS low_stock_count,
        (SELECT max(sm.occurred_at) FROM stock_movements sm WHERE sm.location_id = l.id) AS last_movement_at
       FROM locations l
      WHERE l.business_id = $1
      ORDER BY l.created_at`,
      [session.businessId],
    ),
    // The document form picks a supplier per warehouse; the identity shown is
    // the party's (same COALESCE as getInventoryOverview).
    query<{ location_id: string; id: string; display_name: string }>(
      `SELECT s.location_id, s.id, COALESCE(p.name, s.name) AS display_name
         FROM suppliers s
         LEFT JOIN parties p ON p.id = s.party_id AND p.business_id = $1
        WHERE s.is_active
          AND s.location_id IN (SELECT id FROM locations WHERE business_id = $1)
        ORDER BY s.location_id, COALESCE(p.name, s.name)`,
      [session.businessId],
    ),
  ]);

  const suppliersByLocation = new Map<string, { id: string; name: string }[]>();
  for (const s of suppliers) {
    const list = suppliersByLocation.get(s.location_id);
    if (list) list.push({ id: s.id, name: s.display_name });
    else suppliersByLocation.set(s.location_id, [{ id: s.id, name: s.display_name }]);
  }

  return NextResponse.json({
    warehouses: warehouses.map((w) => ({
      ...w,
      suppliers: suppliersByLocation.get(w.id) ?? [],
    })),
  });
});

/**
 * «افزودن انبار» — create a location. Same gate as the rest of the inventory
 * module; the write itself is branch-service's createBranch, so the branches
 * screen and this one can never drift apart.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { name?: string; address?: string; phone?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  try {
    const { locationId } = await createBranch({
      businessId: session.businessId,
      name: body.name,
      address: body.address,
      phone: body.phone,
      timezone: "Asia/Tehran",
      copyMenuFromLocationId: null,
      actorId: session.sub,
    });
    return NextResponse.json({ id: locationId }, { status: 201 });
  } catch (err) {
    if (err instanceof BranchError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
