/**
 * POS adapters — menu items, menu categories, modifiers and orders.
 *
 * `menu_items`, `menu_categories`, `modifier_groups` and `modifiers` are all
 * **location-scoped**: they belong to a branch, not to the business, so every
 * statement here keys on `location_id` and the engine refuses the entity
 * without an active branch (`locationScoped: true` in the registry).
 *
 * Orders are export-only and deliberately so: a POS order is the product of a
 * till session with inventory movements, a journal entry and a payment behind
 * it. Importing a row into `orders` would produce revenue with no COGS, no
 * stock decrement and no ledger — a number that looks like a sale and
 * reconciles with nothing. Historical sales belong in the backdated-order flow
 * (`orders.backdate`), which does all of that properly.
 */

import { query } from "../../db";
import { postgresDateToIso } from "../../jalali";
import {
  registerAdapter,
  RowRejection,
  type EntityAdapter,
  type WriteOutcome,
} from "../adapters";

function isoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return postgresDateToIso(value);
  return String(value).slice(0, 10);
}

function text(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** A branch is required for every entity in this file. */
function requireLocation(locationId: string | null): string {
  if (!locationId) throw new RowRejection("شعبهٔ فعالی برای این عملیات انتخاب نشده است.");
  return locationId;
}

async function resolveCategory(
  locationId: string,
  name: string,
  create: boolean,
): Promise<{ id: string; label: string } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM menu_categories
      WHERE location_id = $1 AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
    [locationId, trimmed],
  );
  if (rows[0]) return { id: rows[0].id, label: rows[0].name };
  if (!create) return null;
  const { rows: created } = await query<{ id: string; name: string }>(
    `INSERT INTO menu_categories (location_id, name, sort_order)
     VALUES ($1, $2, (SELECT coalesce(max(sort_order), 0) + 1
                        FROM menu_categories WHERE location_id = $1))
     RETURNING id, name`,
    [locationId, trimmed],
  );
  return created[0] ? { id: created[0].id, label: created[0].name } : null;
}

const categoriesAdapter: EntityAdapter = {
  entity: "pos.categories",
  async read(context, options) {
    const locationId = requireLocation(context.locationId);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT id, name, tax_rate AS "taxRate", sort_order AS "sortOrder",
              is_active AS "isActive"
         FROM menu_categories
        WHERE location_id = $1
        ORDER BY sort_order, name
        LIMIT $2`,
      [locationId, options.limit],
    );
    return rows.map((row) => ({ ...row, taxRate: Number(row.taxRate ?? 0) }));
  },
  async write(context, values, options) {
    const locationId = requireLocation(context.locationId);
    const name = text(values.name);
    if (!name) throw new RowRejection("نام دسته الزامی است.");

    const existing = await resolveCategory(locationId, name, false);
    if (existing && options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: `دستهٔ «${name}» از پیش وجود دارد.` };
    }
    if (existing && options.duplicateStrategy === "update") {
      await query(
        `UPDATE menu_categories
            SET tax_rate = coalesce($3, tax_rate),
                sort_order = coalesce($4, sort_order),
                is_active = coalesce($5, is_active)
          WHERE location_id = $1 AND id = $2`,
        [
          locationId,
          existing.id,
          values.taxRate ?? null,
          values.sortOrder ?? null,
          values.isActive ?? null,
        ],
      );
      return { status: "updated", id: existing.id };
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO menu_categories (location_id, name, tax_rate, sort_order, is_active)
       VALUES ($1, $2, coalesce($3, 0),
               coalesce($4, (SELECT coalesce(max(sort_order), 0) + 1
                               FROM menu_categories WHERE location_id = $1)),
               coalesce($5, true))
       RETURNING id`,
      [locationId, name, values.taxRate ?? null, values.sortOrder ?? null, values.isActive ?? null],
    );
    return { status: "created", id: rows[0].id };
  },
  async resolveReference(context, lookup, { create }) {
    return resolveCategory(requireLocation(context.locationId), lookup, create);
  },
};

const productsAdapter: EntityAdapter = {
  entity: "pos.products",
  async read(context, options) {
    const locationId = requireLocation(context.locationId);
    const where = ["mi.location_id = $1"];
    const params: unknown[] = [locationId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`mi.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.categoryId === "string" && options.filters.categoryId) {
      params.push(options.filters.categoryId);
      where.push(`mi.category_id = $${params.length}::uuid`);
    }
    if (options.filters.activeOnly === true) where.push("mi.is_active");
    if (typeof options.filters.search === "string" && options.filters.search.trim()) {
      params.push(options.filters.search.trim());
      where.push(`mi.name ILIKE '%' || $${params.length} || '%'`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT mi.id, mi.name, mc.name AS "categoryName", mi.price, mi.sku,
              mi.description, mi.sort_order AS "sortOrder", mi.is_active AS "isActive",
              mi.created_at AS "createdAt"
         FROM menu_items mi
         LEFT JOIN menu_categories mc ON mc.id = mi.category_id
        WHERE ${where.join(" AND ")}
        ORDER BY mc.sort_order NULLS LAST, mi.sort_order, mi.name
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      price: Number(row.price ?? 0),
      createdAt: isoDate(row.createdAt),
    }));
  },
  async write(context, values, options) {
    const locationId = requireLocation(context.locationId);
    const name = text(values.name);
    if (!name) throw new RowRejection("نام آیتم الزامی است.");
    const warnings: string[] = [];

    let categoryId: string | null = null;
    const categoryName = text(values.categoryName);
    if (categoryName) {
      const strategy = options.relationStrategy.categoryName ?? "create";
      const resolved = await resolveCategory(locationId, categoryName, strategy === "create");
      if (resolved) categoryId = resolved.id;
      else if (strategy === "skip") {
        return { status: "skipped", reason: `دستهٔ «${categoryName}» وجود ندارد.` };
      } else warnings.push(`دستهٔ «${categoryName}» وجود ندارد و آیتم بدون دسته ثبت شد.`);
    }

    const sku = text(values.sku);
    let existing: { id: string } | null = null;
    if (options.duplicateRule === "sku" && sku) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM menu_items
          WHERE location_id = $1 AND lower(btrim(sku)) = lower(btrim($2)) LIMIT 1`,
        [locationId, sku],
      );
      existing = rows[0] ?? null;
    } else if (options.duplicateRule === "name") {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM menu_items
          WHERE location_id = $1 AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
        [locationId, name],
      );
      existing = rows[0] ?? null;
    } else {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM menu_items
          WHERE location_id = $1 AND lower(btrim(name)) = lower(btrim($2))
            AND category_id IS NOT DISTINCT FROM $3::uuid LIMIT 1`,
        [locationId, name, categoryId],
      );
      existing = rows[0] ?? null;
      if (!existing && sku) {
        const bySku = await query<{ id: string }>(
          `SELECT id FROM menu_items
            WHERE location_id = $1 AND lower(btrim(sku)) = lower(btrim($2)) LIMIT 1`,
          [locationId, sku],
        );
        existing = bySku.rows[0] ?? null;
      }
    }

    if (existing && options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: `آیتم «${name}» از پیش در منو هست.` };
    }
    if (existing && options.duplicateStrategy === "update") {
      await query(
        `UPDATE menu_items
            SET name = $3,
                category_id = coalesce($4::uuid, category_id),
                price = coalesce($5, price),
                sku = coalesce($6, sku),
                description = coalesce($7, description),
                sort_order = coalesce($8, sort_order),
                is_active = coalesce($9, is_active),
                updated_at = now()
          WHERE location_id = $1 AND id = $2`,
        [
          locationId,
          existing.id,
          name,
          categoryId,
          values.price ?? null,
          sku,
          text(values.description),
          values.sortOrder ?? null,
          values.isActive ?? null,
        ],
      );
      return { status: "updated", id: existing.id, warnings };
    }

    if (!categoryId) {
      // menu_items.category_id is nullable, but an item nobody can find on the
      // till is not a successful import.
      const fallback = await resolveCategory(locationId, "دسته‌بندی نشده", true);
      categoryId = fallback?.id ?? null;
      warnings.push("آیتم در دستهٔ «دسته‌بندی نشده» ثبت شد.");
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO menu_items
         (location_id, category_id, name, description, sku, price, sort_order, is_active)
       VALUES ($1, $2::uuid, $3, $4, $5, coalesce($6, 0),
               coalesce($7, (SELECT coalesce(max(sort_order), 0) + 1
                               FROM menu_items WHERE location_id = $1)),
               coalesce($8, true))
       RETURNING id`,
      [
        locationId,
        categoryId,
        name,
        text(values.description),
        sku,
        values.price ?? null,
        values.sortOrder ?? null,
        values.isActive ?? null,
      ],
    );
    return { status: "created", id: rows[0].id, warnings };
  },
};

const modifiersAdapter: EntityAdapter = {
  entity: "pos.modifiers",
  async read(context, options) {
    const locationId = requireLocation(context.locationId);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT m.id, g.name AS "groupName", m.name, m.price_delta AS "priceDelta",
              g.min_select AS "minSelect", g.max_select AS "maxSelect",
              m.sort_order AS "sortOrder", m.is_active AS "isActive"
         FROM modifiers m
         JOIN modifier_groups g ON g.id = m.group_id
        WHERE m.location_id = $1
        ORDER BY g.sort_order, g.name, m.sort_order, m.name
        LIMIT $2`,
      [locationId, options.limit],
    );
    return rows.map((row) => ({ ...row, priceDelta: Number(row.priceDelta ?? 0) }));
  },
  async write(context, values, options): Promise<WriteOutcome> {
    const locationId = requireLocation(context.locationId);
    const groupName = text(values.groupName);
    const name = text(values.name);
    if (!groupName) throw new RowRejection("نام گروه افزودنی الزامی است.");
    if (!name) throw new RowRejection("نام افزودنی الزامی است.");

    const { rows: groups } = await query<{ id: string }>(
      `SELECT id FROM modifier_groups
        WHERE location_id = $1 AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
      [locationId, groupName],
    );
    let groupId = groups[0]?.id ?? null;
    if (!groupId) {
      const { rows: created } = await query<{ id: string }>(
        `INSERT INTO modifier_groups (location_id, name, min_select, max_select, sort_order)
         VALUES ($1, $2, coalesce($3, 0), coalesce($4, 1),
                 (SELECT coalesce(max(sort_order), 0) + 1
                    FROM modifier_groups WHERE location_id = $1))
         RETURNING id`,
        [locationId, groupName, values.minSelect ?? null, values.maxSelect ?? null],
      );
      groupId = created[0].id;
    } else if (values.minSelect !== undefined || values.maxSelect !== undefined) {
      await query(
        `UPDATE modifier_groups
            SET min_select = coalesce($3, min_select), max_select = coalesce($4, max_select)
          WHERE location_id = $1 AND id = $2`,
        [locationId, groupId, values.minSelect ?? null, values.maxSelect ?? null],
      );
    }

    const { rows: existingRows } = await query<{ id: string }>(
      `SELECT id FROM modifiers
        WHERE location_id = $1 AND group_id = $2 AND lower(btrim(name)) = lower(btrim($3))
        LIMIT 1`,
      [locationId, groupId, name],
    );
    const existing = existingRows[0];
    if (existing && options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: `افزودنی «${name}» از پیش وجود دارد.` };
    }
    if (existing && options.duplicateStrategy === "update") {
      await query(
        `UPDATE modifiers
            SET price_delta = coalesce($3, price_delta),
                sort_order = coalesce($4, sort_order),
                is_active = coalesce($5, is_active)
          WHERE location_id = $1 AND id = $2`,
        [
          locationId,
          existing.id,
          values.priceDelta ?? null,
          values.sortOrder ?? null,
          values.isActive ?? null,
        ],
      );
      return { status: "updated", id: existing.id };
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO modifiers (location_id, group_id, name, price_delta, sort_order, is_active)
       VALUES ($1, $2, $3, coalesce($4, 0),
               coalesce($5, (SELECT coalesce(max(sort_order), 0) + 1
                               FROM modifiers WHERE group_id = $2)),
               coalesce($6, true))
       RETURNING id`,
      [
        locationId,
        groupId,
        name,
        values.priceDelta ?? null,
        values.sortOrder ?? null,
        values.isActive ?? null,
      ],
    );
    return { status: "created", id: rows[0].id };
  },
};

const ordersAdapter: EntityAdapter = {
  entity: "pos.orders",
  async read(context, options) {
    const locationId = requireLocation(context.locationId);
    const where = ["o.location_id = $1"];
    const params: unknown[] = [locationId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`o.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.status === "string" && options.filters.status) {
      params.push(options.filters.status);
      where.push(`o.status = $${params.length}::order_status`);
    }
    if (typeof options.filters.dateFrom === "string" && options.filters.dateFrom) {
      params.push(options.filters.dateFrom);
      where.push(`o.opened_at >= $${params.length}::date`);
    }
    if (typeof options.filters.dateTo === "string" && options.filters.dateTo) {
      params.push(options.filters.dateTo);
      where.push(`o.opened_at < ($${params.length}::date + interval '1 day')`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT o.id, o.order_number AS "orderNumber", o.type::text AS type,
              o.status::text AS status, p.name AS "customerName",
              o.subtotal, o.discount, o.tax, o.service_charge AS "serviceCharge",
              o.total, o.note, o.opened_at AS "openedAt", o.closed_at AS "closedAt",
              (SELECT count(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS "itemCount"
         FROM orders o
         LEFT JOIN parties p ON p.id = o.customer_id
        WHERE ${where.join(" AND ")}
        ORDER BY o.opened_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      orderNumber: Number(row.orderNumber ?? 0),
      subtotal: Number(row.subtotal ?? 0),
      discount: Number(row.discount ?? 0),
      tax: Number(row.tax ?? 0),
      serviceCharge: Number(row.serviceCharge ?? 0),
      total: Number(row.total ?? 0),
      openedAt: isoDate(row.openedAt),
      closedAt: isoDate(row.closedAt),
    }));
  },
};

export function registerPosAdapters(): void {
  registerAdapter(categoriesAdapter);
  registerAdapter(productsAdapter);
  registerAdapter(modifiersAdapter);
  registerAdapter(ordersAdapter);
}
