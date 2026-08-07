import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSetting, markStepDone, SETTING_KEYS } from "@/lib/settings";
import {
  resolveActiveLocation,
  requireManager,
  type TaxSetting,
} from "@/lib/setup-state";
import {
  parseMenuCsv,
  rowsToImport,
  type ImportResult,
} from "@/lib/menu-import";
import { xlsxToRows } from "@/lib/xlsx-import";
import { withTenantScope } from "@/lib/auth";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Step 6 — CSV/Excel menu import (multipart form, field "file").
 * Categories are matched by name (created with the default tax rate);
 * an item that already exists in its category gets its price updated,
 * otherwise it is created.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location)
    return NextResponse.json({ error: "no_location" }, { status: 409 });

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!file)
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  }

  const name = file.name.toLowerCase();
  let result: ImportResult;
  try {
    if (name.endsWith(".xlsx")) {
      result = rowsToImport(await xlsxToRows(await file.arrayBuffer()));
    } else if (
      name.endsWith(".csv") ||
      name.endsWith(".txt") ||
      name.endsWith(".tsv")
    ) {
      result = parseMenuCsv(await file.text());
    } else {
      return NextResponse.json(
        { error: "unsupported_format" },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json({ error: "parse_failed" }, { status: 400 });
  }

  if (result.items.length === 0) {
    return NextResponse.json(
      { error: "nothing_to_import", messages: result.errors },
      { status: 400 },
    );
  }

  const tax = await getSetting<TaxSetting>(
    session.businessId,
    SETTING_KEYS.tax,
  );
  const defaultTaxRate = tax?.defaultRate ?? 0;

  let createdCategories = 0;
  let createdItems = 0;
  let updatedItems = 0;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const categoryIdByName = new Map<string, string>();
    const { rows: existingCats } = await client.query(
      "SELECT id, name FROM menu_categories WHERE location_id = $1",
      [location.id],
    );
    for (const c of existingCats) categoryIdByName.set(c.name, c.id);

    for (const catName of result.categories) {
      if (!categoryIdByName.has(catName)) {
        const { rows } = await client.query(
          `INSERT INTO menu_categories (location_id, name, tax_rate, sort_order)
           SELECT $1, $2, $3, COALESCE(MAX(sort_order) + 1, 0)
             FROM menu_categories WHERE location_id = $1
           RETURNING id`,
          [location.id, catName, defaultTaxRate],
        );
        categoryIdByName.set(catName, rows[0].id);
        createdCategories++;
      }
    }

    if (result.items.length > 0) {
      const itemCategoryIds = result.items.map(
        (i) => categoryIdByName.get(i.category)!,
      );
      const itemNames = result.items.map((i) => i.name);

      const { rows: existingRows } = await client.query(
        `SELECT m.id, m.category_id, m.name
         FROM menu_items m
         JOIN unnest($1::uuid[], $2::text[]) AS i(category_id, name)
           ON m.category_id = i.category_id AND m.name = i.name
         WHERE m.location_id = $3`,
        [itemCategoryIds, itemNames, location.id],
      );

      const existingMap = new Map<string, string>();
      for (const row of existingRows) {
        existingMap.set(`${row.category_id}-${row.name}`, row.id);
      }

      const updates = [];
      const inserts = [];

      for (const item of result.items) {
        const categoryId = categoryIdByName.get(item.category)!;
        const existingId = existingMap.get(`${categoryId}-${item.name}`);
        if (existingId) {
          updates.push({ ...item, id: existingId });
        } else {
          inserts.push({ ...item, categoryId });
        }
      }

      if (updates.length > 0) {
        await client.query(
          `UPDATE menu_items
           SET price = i.price,
               description = COALESCE(i.description, menu_items.description),
               sku = COALESCE(i.sku, menu_items.sku),
               updated_at = now()
           FROM unnest($1::uuid[], $2::bigint[], $3::text[], $4::text[]) AS i(id, price, description, sku)
           WHERE menu_items.id = i.id`,
          [
            updates.map((u) => u.id),
            updates.map((u) => u.price),
            updates.map((u) => u.description ?? null),
            updates.map((u) => u.sku ?? null),
          ],
        );
        updatedItems += updates.length;
      }

      if (inserts.length > 0) {
        await client.query(
          `INSERT INTO menu_items (location_id, category_id, name, price, description, sku, sort_order)
           SELECT $1, i.category_id, i.name, i.price, i.description, i.sku,
                  COALESCE((SELECT MAX(sort_order) FROM menu_items WHERE location_id = $1 AND category_id = i.category_id), -1) + row_number() over (partition by i.category_id)
           FROM unnest($2::uuid[], $3::text[], $4::bigint[], $5::text[], $6::text[]) AS i(category_id, name, price, description, sku)`,
          [
            location.id,
            inserts.map((i) => i.categoryId),
            inserts.map((i) => i.name),
            inserts.map((i) => i.price),
            inserts.map((i) => i.description ?? null),
            inserts.map((i) => i.sku ?? null),
          ],
        );
        createdItems += inserts.length;
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const progress = await markStepDone(session.businessId, "menu");
  return NextResponse.json({
    ok: true,
    createdCategories,
    createdItems,
    updatedItems,
    errors: result.errors,
    progress,
  });
});
