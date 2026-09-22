/**
 * Inventory adapters — stock items, current stock levels and warehouses.
 *
 * `inventory_items` is location-scoped, like the menu: an anbar belongs to a
 * branch. Stock *levels* and warehouses are export-only:
 *
 *  - A stock level is the running total of `stock_movements`, each of which
 *    carries a cost layer and a journal entry. Setting a quantity directly
 *    would desynchronise the ledger from the shelf; a physical count is what
 *    changes a level, and the count flow already exists (`stock_counts`).
 *  - A "warehouse" in this product is a branch (`locations`), created through
 *    branch management with its own settings, printers and staff — not
 *    something to bulk-create from a spreadsheet.
 */

import { query } from "../../db";
import { postgresDateToIso } from "../../jalali";
import { registerAdapter, RowRejection, type EntityAdapter } from "../adapters";

function isoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return postgresDateToIso(value);
  return String(value).slice(0, 10);
}

function text(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

function requireLocation(locationId: string | null): string {
  if (!locationId) throw new RowRejection("شعبهٔ فعالی برای این عملیات انتخاب نشده است.");
  return locationId;
}

const itemsAdapter: EntityAdapter = {
  entity: "inventory.items",
  async read(context, options) {
    const locationId = requireLocation(context.locationId);
    const where = ["i.location_id = $1"];
    const params: unknown[] = [locationId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`i.id = ANY($${params.length}::uuid[])`);
    }
    if (options.filters.activeOnly === true) where.push("i.is_active");
    if (typeof options.filters.search === "string" && options.filters.search.trim()) {
      params.push(options.filters.search.trim());
      where.push(`i.name ILIKE '%' || $${params.length} || '%'`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT i.id, i.name, i.sku, i.unit, i.reorder_level AS "reorderLevel",
              i.purchase_unit AS "purchaseUnit",
              i.purchase_unit_factor AS "purchaseUnitFactor",
              i.avg_cost AS "avgCost", i.is_active AS "isActive",
              i.created_at AS "createdAt"
         FROM inventory_items i
        WHERE ${where.join(" AND ")}
        ORDER BY i.name
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      reorderLevel: row.reorderLevel === null ? null : Number(row.reorderLevel),
      purchaseUnitFactor:
        row.purchaseUnitFactor === null ? null : Number(row.purchaseUnitFactor),
      // avg_cost is numeric Rial; the money field renders it in the business's
      // display unit, so it must arrive as a number, not a numeric string.
      avgCost: Math.round(Number(row.avgCost ?? 0)),
      createdAt: isoDate(row.createdAt),
    }));
  },
  async write(context, values, options) {
    const locationId = requireLocation(context.locationId);
    const name = text(values.name);
    if (!name) throw new RowRejection("نام کالا الزامی است.");
    const unit = text(values.unit);
    if (!unit) throw new RowRejection("واحد شمارش کالا الزامی است.");
    const sku = text(values.sku);

    let existing: { id: string } | null = null;
    if (options.duplicateRule === "name" || !sku) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM inventory_items
          WHERE location_id = $1 AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
        [locationId, name],
      );
      existing = rows[0] ?? null;
    } else {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM inventory_items
          WHERE location_id = $1 AND lower(btrim(sku)) = lower(btrim($2)) LIMIT 1`,
        [locationId, sku],
      );
      existing = rows[0] ?? null;
    }

    if (existing && options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: `کالای «${name}» از پیش ثبت شده است.` };
    }
    if (existing && options.duplicateStrategy === "update") {
      await query(
        `UPDATE inventory_items
            SET name = $3, unit = coalesce($4, unit), sku = coalesce($5, sku),
                reorder_level = coalesce($6, reorder_level),
                purchase_unit = coalesce($7, purchase_unit),
                purchase_unit_factor = coalesce($8, purchase_unit_factor),
                is_active = coalesce($9, is_active)
          WHERE location_id = $1 AND id = $2`,
        [
          locationId,
          existing.id,
          name,
          unit,
          sku,
          values.reorderLevel ?? null,
          text(values.purchaseUnit),
          values.purchaseUnitFactor ?? null,
          values.isActive ?? null,
        ],
      );
      return { status: "updated", id: existing.id };
    }

    // `avg_cost` is deliberately left at its default. Cost is the weighted
    // average of actual purchase layers; a number typed into a spreadsheet
    // column would silently restate the value of stock that was bought at a
    // different price, and every COGS figure after it.
    const { rows } = await query<{ id: string }>(
      `INSERT INTO inventory_items
         (location_id, name, sku, unit, reorder_level, purchase_unit,
          purchase_unit_factor, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, 1), coalesce($8, true))
       RETURNING id`,
      [
        locationId,
        name,
        sku,
        unit,
        values.reorderLevel ?? null,
        text(values.purchaseUnit),
        values.purchaseUnitFactor ?? null,
        values.isActive ?? null,
      ],
    );
    return { status: "created", id: rows[0].id };
  },
  async resolveReference(context, lookup) {
    const locationId = requireLocation(context.locationId);
    const needle = lookup.trim();
    if (!needle) return null;
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM inventory_items
        WHERE location_id = $1
          AND (lower(btrim(name)) = lower(btrim($2)) OR lower(btrim(sku)) = lower(btrim($2)))
        LIMIT 1`,
      [locationId, needle],
    );
    return rows[0] ? { id: rows[0].id, label: rows[0].name } : null;
  },
};

const stockAdapter: EntityAdapter = {
  entity: "inventory.stock",
  async read(context, options) {
    const locationId = requireLocation(context.locationId);
    const where = ["i.location_id = $1"];
    const params: unknown[] = [locationId];
    if (options.filters.belowReorder === true) {
      where.push(`i.reorder_level IS NOT NULL AND coalesce(sm.quantity, 0) <= i.reorder_level`);
    }
    if (options.filters.activeOnly === true) where.push("i.is_active");
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `WITH movement_totals AS (
         SELECT inventory_item_id, sum(quantity) AS quantity
           FROM stock_movements
          WHERE location_id = $1
          GROUP BY inventory_item_id
       )
       SELECT i.name AS "itemName", i.sku, i.unit,
              coalesce(sm.quantity, 0) AS quantity,
              i.reorder_level AS "reorderLevel",
              i.avg_cost AS "avgCost",
              round(coalesce(sm.quantity, 0) * i.avg_cost) AS "stockValue"
         FROM inventory_items i
         LEFT JOIN movement_totals sm ON sm.inventory_item_id = i.id
        WHERE ${where.join(" AND ")}
        ORDER BY i.name
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      quantity: Number(row.quantity ?? 0),
      reorderLevel: row.reorderLevel === null ? null : Number(row.reorderLevel),
      avgCost: Math.round(Number(row.avgCost ?? 0)),
      stockValue: Math.round(Number(row.stockValue ?? 0)),
    }));
  },
};

const warehousesAdapter: EntityAdapter = {
  entity: "inventory.warehouses",
  async read(context, options) {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT l.id, l.name, l.address, l.phone, l.timezone, l.is_active AS "isActive",
              (SELECT count(*)::int FROM inventory_items i WHERE i.location_id = l.id)
                AS "itemCount"
         FROM locations l
        WHERE l.business_id = $1
        ORDER BY l.name
        LIMIT $2`,
      [context.businessId, options.limit],
    );
    return rows;
  },
};

export function registerInventoryAdapters(): void {
  registerAdapter(itemsAdapter);
  registerAdapter(stockAdapter);
  registerAdapter(warehousesAdapter);
}
