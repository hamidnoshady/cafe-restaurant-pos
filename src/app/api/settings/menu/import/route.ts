import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import {
  parseMenuCsv,
  rowsToImport,
  type ImportMoneyUnit,
  type ImportResult,
} from "@/lib/menu-import";
import { resolveActiveLocation } from "@/lib/setup-state";
import { xlsxToRows } from "@/lib/xlsx-import";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface TaxSetting {
  defaultRate: number;
}

interface BusinessPrefs {
  currencyDisplay?: "toman" | "rial";
}

function preview(result: ImportResult) {
  const modifierGroups = new Set(
    result.items
      .map((item) => item.modifierGroup)
      .filter((name): name is string => Boolean(name)),
  ).size;
  // The same «نوع شیر» group is usually listed on every drink that offers it;
  // counting one entry per item made a 10-drink menu claim 10× the modifiers
  // the import actually writes. Count what apply() would create: one row per
  // distinct (group, name) pair.
  const modifierKeys = new Set<string>();
  for (const item of result.items)
    for (const modifier of item.modifiers ?? [])
      modifierKeys.add(`${item.modifierGroup}\u0000${modifier.name}`);
  return {
    items: result.items.length,
    categories: result.categories.length,
    modifierGroups,
    modifiers: modifierKeys.size,
    errors: result.errors,
  };
}

/**
 * How the parsed rows collide with what is already on this branch's menu.
 * Import is an *upsert*: a row whose (category, name) already exists has its
 * price/description/sku overwritten. That is the operation's most surprising
 * side, so the preview says how many rows merge versus create — the counts are
 * advisory (another import in between can shift them), which is why they are
 * not part of the apply-side validation.
 */
async function existingMatches(locationId: string, result: ImportResult) {
  if (result.items.length === 0) return null;
  const client = await getPool().connect();
  try {
    const { rows: categories } = await client.query<{ count: string; inactive: string }>(
      `SELECT COUNT(*)::text AS count,
              COUNT(*) FILTER (WHERE NOT is_active)::text AS inactive
         FROM menu_categories
        WHERE location_id = $1 AND name = ANY($2::text[])`,
      [locationId, result.categories],
    );
    const { rows: items } = await client.query<{ count: string }>(
      `SELECT COUNT(DISTINCT mi.id)::text AS count
         FROM menu_items mi
         JOIN menu_categories mc ON mc.id = mi.category_id AND mc.location_id = $1
         JOIN unnest($2::text[], $3::text[]) AS u(category, name)
           ON mc.name = u.category AND mi.name = u.name`,
      [
        locationId,
        result.items.map((item) => item.category),
        result.items.map((item) => item.name),
      ],
    );
    return {
      categories: Number(categories[0]?.count ?? 0),
      inactiveCategories: Number(categories[0]?.inactive ?? 0),
      items: Number(items[0]?.count ?? 0),
    };
  } finally {
    client.release();
  }
}

/** Reject ambiguous per-category tax and per-group selection definitions before any rows are written. */
function consistencyErrors(result: ImportResult): string[] {
  const errors: string[] = [];
  const categoryRates = new Map<string, number>();
  const groupRules = new Map<string, string>();
  const modifierPrices = new Map<string, number>();
  for (const item of result.items) {
    if (item.taxRate !== undefined) {
      const current = categoryRates.get(item.category);
      if (current !== undefined && current !== item.taxRate)
        errors.push(`دستهٔ «${item.category}» بیش از یک نرخ مالیات دارد.`);
      categoryRates.set(item.category, item.taxRate);
    }
    if (item.modifierGroup) {
      const rule = `${item.modifierMinSelect ?? 0}/${item.modifierMaxSelect ?? 1}`;
      const current = groupRules.get(item.modifierGroup);
      if (current !== undefined && current !== rule)
        errors.push(
          `گروه افزودنی «${item.modifierGroup}» بیش از یک محدودهٔ انتخاب دارد.`,
        );
      groupRules.set(item.modifierGroup, rule);
      // Without this, two rows listing «شیر بادام:25000» and «شیر بادام:30000»
      // in the same group would silently resolve to whichever row apply()
      // happened to reach last.
      for (const modifier of item.modifiers ?? []) {
        const key = `${item.modifierGroup}\u0000${modifier.name}`;
        const currentPrice = modifierPrices.get(key);
        if (currentPrice !== undefined && currentPrice !== modifier.priceDelta)
          errors.push(
            `افزودنی «${modifier.name}» در گروه «${item.modifierGroup}» بیش از یک قیمت دارد.`,
          );
        modifierPrices.set(key, modifier.priceDelta);
      }
    }
  }
  return [...new Set(errors)];
}

/** Full menu import for Settings. It supports preview and never marks a wizard step. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(
    PERMISSIONS.settingsManage,
  );
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location)
    return NextResponse.json({ error: "no_location" }, { status: 409 });

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
  if (!file)
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  if (file.size > MAX_FILE_BYTES)
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });

  let result: ImportResult;
  try {
    // Prices in the file are read in the business's own display unit, the same
    // unit every money input in the app uses. Reading a Rial business's file
    // as Toman would store every price 10× too high.
    const prefs = await getSetting<BusinessPrefs>(
      session.businessId,
      SETTING_KEYS.businessPrefs,
    );
    const unit: ImportMoneyUnit =
      prefs?.currencyDisplay === "rial" ? "rial" : "toman";
    const name = file.name.toLowerCase();
    if (name.endsWith(".xlsx"))
      result = rowsToImport(await xlsxToRows(await file.arrayBuffer()), unit);
    else if (
      name.endsWith(".csv") ||
      name.endsWith(".txt") ||
      name.endsWith(".tsv")
    )
      result = parseMenuCsv(await file.text(), unit);
    else
      return NextResponse.json(
        { error: "unsupported_format" },
        { status: 400 },
      );
  } catch {
    return NextResponse.json({ error: "parse_failed" }, { status: 400 });
  }
  result.errors.push(...consistencyErrors(result));
  if (result.items.length === 0) {
    return NextResponse.json(
      {
        error: "nothing_to_import",
        errors: result.errors.length
          ? result.errors
          : ["آیتمی برای ورود پیدا نشد."],
      },
      { status: 400 },
    );
  }
  if (mode === "preview") {
    // Advisory only: a failed lookup degrades the preview to counts alone
    // rather than failing the whole request.
    let matches: Awaited<ReturnType<typeof existingMatches>> = null;
    try {
      matches = await existingMatches(location.id, result);
    } catch {
      matches = null;
    }
    return NextResponse.json({ preview: { ...preview(result), matches } });
  }
  if (result.errors.length > 0)
    return NextResponse.json(
      { error: "invalid_import", errors: result.errors },
      { status: 400 },
    );

  const tax = await getSetting<TaxSetting>(
    session.businessId,
    SETTING_KEYS.tax,
  );
  const defaultTaxRate = tax?.defaultRate ?? 0;
  const categoryTaxRate = new Map<string, number>();
  for (const item of result.items)
    if (item.taxRate !== undefined)
      categoryTaxRate.set(item.category, item.taxRate);

  let createdCategories = 0;
  let createdItems = 0;
  let updatedItems = 0;
  let createdGroups = 0;
  let createdModifiers = 0;
  let reactivatedCategories = 0;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const categoryIdByName = new Map<string, string>();
    const { rows: existingCategories } = await client.query(
      "SELECT id, name, is_active FROM menu_categories WHERE location_id = $1",
      [location.id],
    );
    for (const category of existingCategories)
      categoryIdByName.set(category.name, category.id);

    const categoriesToUpdate: { id: string; taxRate: number | null; wasInactive: boolean }[] = [];
    const categoriesToInsert: { name: string; taxRate: number }[] = [];

    for (const categoryName of result.categories) {
      const taxRate = categoryTaxRate.get(categoryName) ?? defaultTaxRate;
      const existingId = categoryIdByName.get(categoryName);
      if (existingId) {
        // Every category the file writes into is re-activated, the same
        // deliberate upsert the modifiers below get: a category deactivated by
        // an earlier delete (it had ordered items) would otherwise swallow the
        // imported rows into a part of the menu the POS never shows, with no
        // hint of where they went.
        categoriesToUpdate.push({
          id: existingId,
          taxRate: categoryTaxRate.has(categoryName) ? taxRate : null,
          wasInactive: !existingCategories.find((c) => c.id === existingId)?.is_active,
        });
      } else {
        categoriesToInsert.push({ name: categoryName, taxRate });
      }
    }

    if (categoriesToUpdate.length > 0) {
      const ids = categoriesToUpdate.map((c) => c.id);
      const rates = categoriesToUpdate.map((c) => c.taxRate);
      reactivatedCategories = categoriesToUpdate.filter((c) => c.wasInactive).length;
      await client.query(
        `UPDATE menu_categories AS c
         SET tax_rate = COALESCE(u.rate, c.tax_rate),
             is_active = true
         FROM unnest($1::uuid[], $2::numeric[]) AS u(id, rate)
         WHERE c.id = u.id`,
        [ids, rates],
      );
    }

    if (categoriesToInsert.length > 0) {
      for (const cat of categoriesToInsert) {
        const { rows } = await client.query(
          `INSERT INTO menu_categories (location_id, name, tax_rate, sort_order)
           SELECT $1, $2, $3, COALESCE(MAX(sort_order) + 1, 0)
             FROM menu_categories WHERE location_id = $1
           RETURNING id`,
          [location.id, cat.name, cat.taxRate],
        );
        categoryIdByName.set(cat.name, rows[0].id);
        createdCategories++;
      }
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
          [
            item.price,
            item.description ?? null,
            item.sku ?? null,
            existing[0].id,
          ],
        );
        itemIdByIndex.set(index, existing[0].id);
        updatedItems++;
      } else {
        const { rows } = await client.query(
          `INSERT INTO menu_items (location_id, category_id, name, price, description, sku, sort_order)
           SELECT $1, $2, $3, $4, $5, $6, COALESCE(MAX(sort_order) + 1, 0)
             FROM menu_items WHERE location_id = $1 AND category_id = $2
           RETURNING id`,
          [
            location.id,
            categoryId,
            item.name,
            item.price,
            item.description ?? null,
            item.sku ?? null,
          ],
        );
        itemIdByIndex.set(index, rows[0].id);
        createdItems++;
      }
    }

    const groupIdByName = new Map<string, string>();
    const { rows: existingGroups } = await client.query(
      "SELECT id, name FROM modifier_groups WHERE location_id = $1",
      [location.id],
    );
    for (const group of existingGroups) groupIdByName.set(group.name, group.id);
    for (const [index, item] of result.items.entries()) {
      if (!item.modifierGroup) continue;
      const minSelect = item.modifierMinSelect ?? 0;
      const maxSelect =
        item.modifierMaxSelect ?? Math.max(1, item.modifiers?.length ?? 1);
      let groupId = groupIdByName.get(item.modifierGroup);
      if (groupId) {
        await client.query(
          "UPDATE modifier_groups SET min_select = $1, max_select = $2 WHERE id = $3",
          [minSelect, maxSelect, groupId],
        );
      } else {
        const { rows } = await client.query(
          "INSERT INTO modifier_groups (location_id, name, min_select, max_select) VALUES ($1, $2, $3, $4) RETURNING id",
          [location.id, item.modifierGroup, minSelect, maxSelect],
        );
        const createdGroupId = rows[0].id as string;
        groupId = createdGroupId;
        groupIdByName.set(item.modifierGroup, createdGroupId);
        createdGroups++;
      }
      const itemId = itemIdByIndex.get(index)!;
      await client.query(
        `INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [itemId, groupId],
      );
      for (const modifier of item.modifiers ?? []) {
        const { rows: existing } = await client.query(
          "SELECT id FROM modifiers WHERE group_id = $1 AND name = $2",
          [groupId, modifier.name],
        );
        if (existing.length > 0) {
          await client.query(
            "UPDATE modifiers SET price_delta = $1, is_active = true WHERE id = $2",
            [modifier.priceDelta, existing[0].id],
          );
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
  return NextResponse.json({
    ok: true,
    createdCategories,
    createdItems,
    updatedItems,
    createdGroups,
    createdModifiers,
    reactivatedCategories,
  });
});
