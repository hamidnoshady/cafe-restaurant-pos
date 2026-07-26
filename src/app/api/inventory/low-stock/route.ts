import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { isLowStock } from "@/lib/inventory";
import { getStockLevels } from "@/lib/inventory-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/** Items at or below their reorder threshold — feeds the dashboard's low-stock banner/badge. */
export async function GET() {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ items: [] });

  const [{ rows: items }, stockLevels] = await Promise.all([
    query<{ id: string; name: string; unit: string; reorder_level: string | null }>(
      "SELECT id, name, unit, reorder_level FROM inventory_items WHERE location_id = $1 AND is_active",
      [location.id],
    ),
    getStockLevels(location.id),
  ]);

  const low = items
    .map((it) => ({
      id: it.id,
      name: it.name,
      unit: it.unit,
      reorderLevel: it.reorder_level === null ? null : Number(it.reorder_level),
      stock: stockLevels.get(it.id) ?? 0,
    }))
    .filter((it) => isLowStock(it.stock, it.reorderLevel));

  return NextResponse.json({ items: low });
}
