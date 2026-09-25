import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { getStockLevels } from "@/lib/inventory-service";

/**
 * The active items of one *specific* warehouse, with on-hand stock.
 *
 * The inventory workspace's main `/api/inventory` payload is scoped to the
 * member's active branch, but «ثبت انتقال بین انبارها» moves stock between two
 * arbitrary branches: the source dropdown must show the *source* branch's
 * items and the destination dropdown the *destination* branch's items, neither
 * of which is necessarily the active one. This endpoint answers "what items
 * does branch X hold" for either side. Row-level security already narrows
 * `inventory_items` to the caller's business, so a `locationId` from another
 * business simply returns nothing.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const locationId = new URL(request.url).searchParams.get("locationId")?.trim();
  if (!locationId) return NextResponse.json({ items: [] });

  const [{ rows: items }, stockLevels] = await Promise.all([
    query<{
      id: string;
      name: string;
      sku: string | null;
      unit: string;
      is_active: boolean;
    }>(
      `SELECT id, name, sku, unit, is_active
         FROM inventory_items
        WHERE location_id = $1 AND is_active
        ORDER BY name`,
      [locationId],
    ),
    getStockLevels(locationId),
  ]);

  return NextResponse.json({
    items: items.map((item) => ({
      ...item,
      stock: stockLevels.get(item.id) ?? 0,
    })),
  });
});
