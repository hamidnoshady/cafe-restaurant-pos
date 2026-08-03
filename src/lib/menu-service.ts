import { query } from "./db";

export interface MenuItemPatchInput {
  categoryId?: string;
  name?: string;
  price?: number;
  description?: string | null;
  sku?: string | null;
  imageUrl?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  targetMarginPercent?: number | null;
}

/**
 * The location-scoped menu tree shared by the authenticated dashboard and the
 * public API. Keeping the location explicit is what prevents an API key for
 * one branch from reading a sibling branch's menu.
 */
export async function getMenuTree(locationId: string) {
  const [{ rows: categories }, { rows: items }, { rows: modifierGroups }, { rows: modifiers }, { rows: links }] =
    await Promise.all([
      query(
        "SELECT id, name, tax_rate, sort_order, is_active FROM menu_categories WHERE location_id = $1 ORDER BY sort_order, name",
        [locationId],
      ),
      query(
        "SELECT id, category_id, name, description, sku, price, image_url, sort_order, is_active, target_margin_percent FROM menu_items WHERE location_id = $1 ORDER BY sort_order, name",
        [locationId],
      ),
      query(
        "SELECT id, name, min_select, max_select FROM modifier_groups WHERE location_id = $1 ORDER BY name",
        [locationId],
      ),
      query(
        "SELECT id, group_id, name, price_delta, sort_order, is_active FROM modifiers WHERE location_id = $1 ORDER BY sort_order, name",
        [locationId],
      ),
      query(
        "SELECT mimg.menu_item_id, mimg.modifier_group_id FROM menu_item_modifier_groups mimg JOIN menu_items mi ON mi.id = mimg.menu_item_id WHERE mi.location_id = $1",
        [locationId],
      ),
    ]);

  return { categories, items, modifierGroups, modifiers, itemModifierGroups: links };
}

export type UpdateMenuItemResult =
  | { ok: true }
  | { ok: false; error: "bad_request" | "missing_fields" | "item_not_found" | "category_not_found" | "invalid_margin"; status: number };

/**
 * Applies the same allowlisted menu-item update used by the dashboard. Values
 * never become SQL identifiers, and both the item and any new category are
 * constrained to the supplied branch.
 */
export async function updateMenuItem(
  locationId: string,
  id: string,
  body: MenuItemPatchInput,
): Promise<UpdateMenuItemResult> {
  const { rows: existing } = await query<{ id: string }>(
    "SELECT id FROM menu_items WHERE id = $1 AND location_id = $2",
    [id, locationId],
  );
  if (!existing[0]) return { ok: false, error: "item_not_found", status: 404 };

  if (body.categoryId !== undefined) {
    if (typeof body.categoryId !== "string") return { ok: false, error: "bad_request", status: 400 };
    const { rows: category } = await query(
      "SELECT id FROM menu_categories WHERE id = $1 AND location_id = $2",
      [body.categoryId, locationId],
    );
    if (category.length === 0) return { ok: false, error: "category_not_found", status: 404 };
  }

  const fields: string[] = [];
  const values: unknown[] = [id, locationId];
  let parameterIndex = 2;
  const set = (column: string, value: unknown) => {
    parameterIndex += 1;
    fields.push(column + " = $" + parameterIndex);
    values.push(value);
  };

  if (body.categoryId !== undefined) set("category_id", body.categoryId);
  if (body.name !== undefined) {
    if (typeof body.name !== "string") return { ok: false, error: "missing_fields", status: 400 };
    const name = body.name.trim();
    if (!name) return { ok: false, error: "missing_fields", status: 400 };
    set("name", name);
  }
  if (body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isSafeInteger(price) || price < 0) return { ok: false, error: "missing_fields", status: 400 };
    set("price", price);
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") return { ok: false, error: "bad_request", status: 400 };
    set("description", body.description?.trim() || null);
  }
  if (body.sku !== undefined) {
    if (body.sku !== null && typeof body.sku !== "string") return { ok: false, error: "bad_request", status: 400 };
    set("sku", body.sku?.trim() || null);
  }
  if (body.imageUrl !== undefined) {
    if (body.imageUrl !== null && typeof body.imageUrl !== "string") return { ok: false, error: "bad_request", status: 400 };
    set("image_url", body.imageUrl?.trim() || null);
  }
  if (body.sortOrder !== undefined) set("sort_order", Number(body.sortOrder) || 0);
  if (body.isActive !== undefined) set("is_active", Boolean(body.isActive));
  if (body.targetMarginPercent !== undefined) {
    if (body.targetMarginPercent === null) {
      set("target_margin_percent", null);
    } else {
      const margin = Number(body.targetMarginPercent);
      if (!Number.isFinite(margin) || margin < 0 || margin >= 100) {
        return { ok: false, error: "invalid_margin", status: 400 };
      }
      set("target_margin_percent", margin);
    }
  }

  if (fields.length === 0) return { ok: false, error: "bad_request", status: 400 };

  set("updated_at", new Date());
  const result = await query(
    "UPDATE menu_items SET " + fields.join(", ") + " WHERE id = $1 AND location_id = $2",
    values,
  );
  if (result.rowCount !== 1) return { ok: false, error: "item_not_found", status: 404 };
  return { ok: true };
}
