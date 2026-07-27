import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { parseMenuCsv, rowsToImport, type ImportResult } from "@/lib/menu-import";
import { resolveActiveLocation } from "@/lib/setup-state";
import { xlsxToRows } from "@/lib/xlsx-import";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface TaxSetting {
  defaultRate: number;
}

function preview(result: ImportResult) {
  const modifierGroups = new Set(result.items.map((item) => item.modifierGroup).filter((name): name is string => Boolean(name))).size;
  const modifiers = result.items.reduce((total, item) => total + (item.modifiers?.length ?? 0), 0);
  return { items: result.items.length, categories: result.categories.length, modifierGroups, modifiers, errors: result.errors };
}

/** Reject ambiguous per-category tax and per-group selection definitions before any rows are written. */
function consistencyErrors(result: ImportResult): string[] {
  const errors: string[] = [];
  const categoryRates = new Map<string, number>();
  const groupRules = new Map<string, string>();
  for (const item of result.items) {
    if (item.taxRate !== undefined) {
      const current = categoryRates.get(item.category);
      if (current !== undefined && current !== item.taxRate) errors.push(`دستهٔ «${item.category}» بیش از یک نرخ مالیات دارد.`);
      categoryRates.set(item.category, item.taxRate);
    }
    if (item.modifierGroup) {
      const rule = `${item.modifierMinSelect ?? 0}/${item.modifierMaxSelect ?? 1}`;
      const current = groupRules.get(item.modifierGroup);
      if (current !== undefined && current !== rule) errors.push(`گروه افزودنی «${item.modifierGroup}» بیش از یک محدودهٔ انتخاب دارد.`);
      groupRules.set(item.modifierGroup, rule);
    }
  }
  return [...new Set(errors)];
}

/** Full menu import for Settings. It supports preview and never marks a wizard step. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let file: File | null = null;
  let mode = "preview";
  try {
    const form = await request.formData();
    const candidate = form.get("file");
    if (candidate instanceof File) file = candidate;
    mode = form.get("mode") === "apply" ? "apply" : "preview";
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: "missing_file" }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: "file_too_large" }, { status: 413 });

  let result: ImportResult;
  try {
    const name = file.name.toLowerCase();
    if (name.endsWith(".xlsx")) result = rowsToImport(await xlsxToRows(await file.arrayBuffer()));
    else if (name.endsWith(".csv") || name.endsWith(".txt") || name.endsWith(".tsv")) result = parseMenuCsv(await file.text());
    else return NextResponse.json({ error: "unsupported_format" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "parse_failed" }, { status: 400 });
  }
  result.errors.push(...consistencyErrors(result));
  if (result.items.length === 0) {
    return NextResponse.json({ error: "nothing_to_import", errors: result.errors.length ? result.errors : ["آیتمی برای ورود پیدا نشد."] }, { status: 400 });
  }
  if (mode === "preview") return NextResponse.json({ preview: preview(result) });
  if (result.errors.length > 0) return NextResponse.json({ error: "invalid_import", errors: result.errors }, { status: 400 });

  const tax = await getSetting<TaxSetting>(session.businessId, SETTING_KEYS.tax);
  const defaultTaxRate = tax?.defaultRate ?? 0;
  const categoryTaxRate = new Map<string, number>();
  for (const item of result.items) if (item.taxRate !== undefined) categoryTaxRate.set(item.category, item.taxRate);

  let createdCategories = 0;
  let createdItems = 0;
  let updatedItems = 0;
  let createdGroups = 0;
  let createdModifiers = 0;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const categoryIdByName = new Map<string, string>();
    const { rows: existingCategories } = await client.query("SELECT id, name FROM menu_categories WHERE location_id = $1", [location.id]);
    for (const category of existingCategories) categoryIdByName.set(category.name, category.id);

    for (const categoryName of result.categories) {
      const taxRate = categoryTaxRate.get(categoryName) ?? defaultTaxRate;
      const existingId = categoryIdByName.get(categoryName);
      if (existingId) {
        if (categoryTaxRate.has(categoryName)) await client.query("UPDATE menu_categories SET tax_rate = $1 WHERE id = $2", [taxRate, existingId]);
        continue;
      }
      const { rows } = await client.query(
        `INSERT INTO menu_categories (location_id, name, tax_rate, sort_order)
         SELECT $1, $2, $3, COALESCE(MAX(sort_order) + 1, 0)
           FROM menu_categories WHERE location_id = $1
         RETURNING id`,
        [location.id, categoryName, taxRate],
      );
      categoryIdByName.set(categoryName, rows[0].id);
      createdCategories++;
    }

    const itemIdByIndex = new Map<number, string>();
    for (const [index, item] of result.items.entries()) {
      const categoryId = categoryIdByName.get(item.category)!;
      const { rows: existing } = await client.query(
        "SELECT id FROM menu_items WHERE location_id = $1 AND category_id = $2 AND name = $3",
        [location.id, categoryId, item.name],
      );
      if (existing.length > 0) {
        await client.query(
          `UPDATE menu_items
              SET price = $1, description = COALESCE($2, description), sku = COALESCE($3, sku), updated_at = now()
            WHERE id = $4`,
          [item.price, item.description ?? null, item.sku ?? null, existing[0].id],
        );
        itemIdByIndex.set(index, existing[0].id);
        updatedItems++;
      } else {
        const { rows } = await client.query(
          `INSERT INTO menu_items (location_id, category_id, name, price, description, sku, sort_order)
           SELECT $1, $2, $3, $4, $5, $6, COALESCE(MAX(sort_order) + 1, 0)
             FROM menu_items WHERE location_id = $1 AND category_id = $2
           RETURNING id`,
          [location.id, categoryId, item.name, item.price, item.description ?? null, item.sku ?? null],
        );
        itemIdByIndex.set(index, rows[0].id);
        createdItems++;
      }
    }

    const groupIdByName = new Map<string, string>();
    const { rows: existingGroups } = await client.query("SELECT id, name FROM modifier_groups WHERE location_id = $1", [location.id]);
    for (const group of existingGroups) groupIdByName.set(group.name, group.id);
    for (const [index, item] of result.items.entries()) {
      if (!item.modifierGroup) continue;
      const minSelect = item.modifierMinSelect ?? 0;
      const maxSelect = item.modifierMaxSelect ?? Math.max(1, item.modifiers?.length ?? 1);
      let groupId = groupIdByName.get(item.modifierGroup);
      if (groupId) {
        await client.query("UPDATE modifier_groups SET min_select = $1, max_select = $2 WHERE id = $3", [minSelect, maxSelect, groupId]);
      } else {
        const { rows } = await client.query(
          "INSERT INTO modifier_groups (location_id, name, min_select, max_select) VALUES ($1, $2, $3, $4) RETURNING id",
          [location.id, item.modifierGroup, minSelect, maxSelect],
        );
        groupId = rows[0].id;
        groupIdByName.set(item.modifierGroup, groupId);
        createdGroups++;
      }
      const itemId = itemIdByIndex.get(index)!;
      await client.query(
        `INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [itemId, groupId],
      );
      for (const modifier of item.modifiers ?? []) {
        const { rows: existing } = await client.query("SELECT id FROM modifiers WHERE group_id = $1 AND name = $2", [groupId, modifier.name]);
        if (existing.length > 0) {
          await client.query("UPDATE modifiers SET price_delta = $1, is_active = true WHERE id = $2", [modifier.priceDelta, existing[0].id]);
        } else {
          await client.query(
            `INSERT INTO modifiers (location_id, group_id, name, price_delta, sort_order)
             SELECT $1, $2, $3, $4, COALESCE(MAX(sort_order) + 1, 0)
               FROM modifiers WHERE group_id = $2`,
            [location.id, groupId, modifier.name, modifier.priceDelta],
          );
          createdModifiers++;
        }
      }
    }
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true, createdCategories, createdItems, updatedItems, createdGroups, createdModifiers });
});
