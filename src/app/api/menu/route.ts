import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { getPrimaryLocation } from "@/lib/setup-state";

/**
 * Full menu tree for the cashier POS grid and the menu management screen:
 * categories → items → attached modifier groups → modifiers.
 * Any authenticated role may read it (cashier needs it to sell).
 */
export async function GET() {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter", "kitchen");
  if (error) return error;

  const location = await getPrimaryLocation(session.businessId);
  if (!location) {
    return NextResponse.json({ categories: [], items: [], modifierGroups: [], modifiers: [] });
  }

  const [{ rows: categories }, { rows: items }, { rows: modifierGroups }, { rows: modifiers }, { rows: links }] =
    await Promise.all([
      query(
        `SELECT id, name, tax_rate, sort_order, is_active FROM menu_categories
          WHERE location_id = $1 ORDER BY sort_order, name`,
        [location.id],
      ),
      query(
        `SELECT id, category_id, name, description, sku, price, image_url, sort_order, is_active
           FROM menu_items WHERE location_id = $1 ORDER BY sort_order, name`,
        [location.id],
      ),
      query(
        `SELECT id, name, min_select, max_select FROM modifier_groups
          WHERE location_id = $1 ORDER BY name`,
        [location.id],
      ),
      query(
        `SELECT id, group_id, name, price_delta, sort_order, is_active FROM modifiers
          WHERE location_id = $1 ORDER BY sort_order, name`,
        [location.id],
      ),
      query(
        `SELECT mimg.menu_item_id, mimg.modifier_group_id FROM menu_item_modifier_groups mimg
           JOIN menu_items mi ON mi.id = mimg.menu_item_id WHERE mi.location_id = $1`,
        [location.id],
      ),
    ]);

  return NextResponse.json({ categories, items, modifierGroups, modifiers, itemModifierGroups: links });
}
