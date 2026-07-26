import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { getCostingMethod, getStockLevels } from "@/lib/inventory-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Everything the inventory management screen needs in one call: items
 * (with live stock), suppliers, recipes (menu item + modifier), and the
 * pickers (menu items, modifiers) needed to build recipes. Mirrors
 * GET /api/menu's aggregated shape.
 */
export async function GET() {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({
      items: [],
      suppliers: [],
      menuItems: [],
      modifiers: [],
      recipes: [],
      modifierRecipes: [],
      costingMethod: null,
    });
  }

  const [
    { rows: items },
    { rows: suppliers },
    { rows: menuItems },
    { rows: modifiers },
    { rows: recipes },
    { rows: modifierRecipes },
    stockLevels,
    costingMethod,
  ] = await Promise.all([
    query(
      `SELECT id, name, sku, unit, reorder_level, avg_cost, purchase_unit, purchase_unit_factor, is_active
         FROM inventory_items WHERE location_id = $1 ORDER BY name`,
      [location.id],
    ),
    query(
      "SELECT id, name, phone, notes, is_active FROM suppliers WHERE location_id = $1 ORDER BY name",
      [location.id],
    ),
    query("SELECT id, name FROM menu_items WHERE location_id = $1 AND is_active ORDER BY name", [location.id]),
    query(
      `SELECT m.id, m.name, m.group_id, mg.name AS group_name FROM modifiers m
         JOIN modifier_groups mg ON mg.id = m.group_id
        WHERE m.location_id = $1 AND m.is_active ORDER BY mg.name, m.name`,
      [location.id],
    ),
    query(
      `SELECT mii.menu_item_id, mii.inventory_item_id, mii.quantity FROM menu_item_ingredients mii
         JOIN menu_items mi ON mi.id = mii.menu_item_id WHERE mi.location_id = $1`,
      [location.id],
    ),
    query(
      `SELECT modi.modifier_id, modi.inventory_item_id, modi.quantity_delta FROM modifier_ingredients modi
         JOIN modifiers m ON m.id = modi.modifier_id WHERE m.location_id = $1`,
      [location.id],
    ),
    getStockLevels(location.id),
    getCostingMethod(session.businessId),
  ]);

  const itemsWithStock = items.map((it) => ({ ...it, stock: stockLevels.get(it.id as string) ?? 0 }));

  return NextResponse.json({
    items: itemsWithStock,
    suppliers,
    menuItems,
    modifiers,
    recipes,
    modifierRecipes,
    costingMethod,
  });
}
