/**
 * Phase 23 (issue #118) — Wave 3: pull products and customers from a
 * WooCommerce store into the local menu/customer directory, remembering each
 * remote id in integration_mappings. DB-touching (not unit-tested directly).
 *
 * Since Phase 27 Wave 14 — products are routed to the right table by industry:
 * F&B (food_service) continues writing to `menu_items`; retail industries
 * (jewelry, watch, accessories, cosmetics) write to the shared `items` +
 * `item_stock` model, with variant/variable products mapped through
 * `integration_mappings` for parent-child linkage.
 */
import { getPool, query, type PoolClient } from "../db";
import { getBusinessIndustry } from "../industry-guard";
import { getConnection, wooClientFor, type ConnectionRow } from "./connections-service";
import { listMappings, localIdForRemote, upsertMapping } from "./mapping-service";
import { wooAmountToRial } from "./woo-money";
import { writeIntegrationAudit } from "./audit";
import type { WooCustomer, WooProduct, WooVariationAttribute } from "./woocommerce-client";

const PER_PAGE = 100;

async function resolveLocationId(businessId: string, locationId: string | null): Promise<string> {
  if (locationId) return locationId;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  if (!rows[0]) throw new Error("no_location");
  return rows[0].id;
}

export interface SyncOutcome {
  created: number;
  updated: number;
  total: number;
}

/** The branch this connection writes into, resolved once per sync. */
export async function connectionLocationId(connection: ConnectionRow): Promise<string> {
  return resolveLocationId(connection.business_id, connection.location_id);
}

/**
 * One WooCommerce product -> one local row, routed by the business's industry.
 *
 * Split out of `syncProducts` because there are now two ways a product
 * arrives: pulled by the app over REST, or pushed by the WordPress plugin as
 * an event. Both must land identically — same price conversion, same mapping
 * row, same create-vs-update decision — so both call this rather than each
 * carrying its own copy of the rule.
 *
 * F&B (`food_service`) keeps writing `menu_items` (recipe-based). Retail
 * industries (jewelry, watch, accessories, cosmetics) write the shared
 * `items` + `item_stock` model:
 *
 * - `simple`            -> kind='simple' item with an `item_stock` row
 * - `variable` (parent) -> kind='variant_parent' item (not sellable, no stock)
 * - `variation` (child) -> kind='variant_child' item under its parent, with
 *   `item_variant_attributes` and its own `item_stock` row
 *
 * Every remote id — the variable parent and each variation alike — gets its
 * own `integration_mappings` row, so an order line for a variation resolves to
 * the exact sellable child and a stock push targets the right row.
 */
export async function upsertProductFromWoo(
  connection: ConnectionRow,
  locationId: string,
  product: WooProduct,
): Promise<"created" | "updated"> {
  const industry = await getBusinessIndustry(connection.business_id);
  if (industry !== "food_service") {
    return upsertRetailProduct(connection, locationId, product);
  }
  return upsertFnbProduct(connection, locationId, product);
}

/** F&B: one WooCommerce product -> one `menu_items` row. Unchanged since Wave 3. */
async function upsertFnbProduct(
  connection: ConnectionRow,
  locationId: string,
  product: WooProduct,
): Promise<"created" | "updated"> {
  const businessId = connection.business_id;
  const price = wooAmountToRial(product.regular_price || product.price || "0", connection.currency_unit);
  const existing = await localIdForRemote(businessId, connection.id, "product", String(product.id));
  if (existing) {
    await query(
      `UPDATE menu_items SET name = $3, sku = $4, price = $5, updated_at = now()
        WHERE id = $1 AND location_id = $2`,
      [existing, locationId, product.name, product.sku || null, price.toString()],
    );
    return "updated";
  }
  const { rows } = await query<{ id: string }>(
    `INSERT INTO menu_items (location_id, name, sku, price)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [locationId, product.name, product.sku || null, price.toString()],
  );
  await upsertMapping(businessId, connection.id, "product", String(product.id), rows[0].id);
  return "created";
}

/** Retail: route simple/variable/variation WooCommerce products into the `items` model. */
async function upsertRetailProduct(
  connection: ConnectionRow,
  locationId: string,
  product: WooProduct,
): Promise<"created" | "updated"> {
  const businessId = connection.business_id;
  const price = wooAmountToRial(product.regular_price || product.price || "0", connection.currency_unit);
  // WooCommerce reports null stock_quantity when a product does not manage
  // stock; the retail model starts such a product at zero and counts up as
  // receipts land in the app.
  const stockQuantity = product.manage_stock && product.stock_quantity != null ? Math.max(0, product.stock_quantity) : 0;
  const type = product.type || "simple";
  const existing = await localIdForRemote(businessId, connection.id, "product", String(product.id));

  if (existing) {
    await query(
      `UPDATE items SET name = $3, sku = $4, updated_at = now()
        WHERE id = $1 AND location_id = $2`,
      [existing, locationId, product.name, product.sku || null],
    );
    // A variable parent is not sellable — it carries no stock/price of its own.
    if (type !== "variable") {
      await upsertItemStock(existing, stockQuantity, price);
    }
    if (type === "variation" && product.variation_attributes?.length) {
      await replaceVariantAttributes(existing, product.variation_attributes);
    }
    return "updated";
  }

  if (type === "variable") {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO items (location_id, name, sku, kind, tracking)
       VALUES ($1, $2, $3, 'variant_parent', 'none') RETURNING id`,
      [locationId, product.name, product.sku || null],
    );
    await upsertMapping(businessId, connection.id, "product", String(product.id), rows[0].id);
    return "created";
  }

  const isVariation = type === "variation";
  const kind = isVariation ? "variant_child" : "simple";
  let parentItemId: string | null = null;
  if (isVariation && product.parent_id) {
    parentItemId = await localIdForRemote(businessId, connection.id, "product", String(product.parent_id));
    // A variation can arrive before its parent (reordered webhooks/events).
    // Fail this one so the caller retries; the parent lands first next time.
    if (!parentItemId) throw new Error("parent_variant_not_found");
  }

  // Item + stock + attributes + mapping in one transaction, so a retry after a
  // partial failure cannot orphan a stock row or duplicate a variant.
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO items (location_id, parent_item_id, name, sku, kind, tracking)
       VALUES ($1, $2, $3, $4, $5, 'none') RETURNING id`,
      [locationId, parentItemId, product.name, product.sku || null, kind],
    );
    const itemId = rows[0].id;
    await client.query(
      `INSERT INTO item_stock (item_id, quantity, unit_price)
       VALUES ($1, $2, $3)`,
      [itemId, stockQuantity, price > 0n ? Number(price) : null],
    );
    if (isVariation && product.variation_attributes?.length) {
      for (const attr of product.variation_attributes) {
        if (!attr.name || !attr.option) continue;
        await client.query(
          `INSERT INTO item_variant_attributes (item_id, name, value) VALUES ($1, $2, $3)`,
          [itemId, attr.name, attr.option],
        );
      }
    }
    await client.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'product', $3, $4)
       ON CONFLICT (connection_id, entity_type, remote_id)
       DO UPDATE SET local_id = EXCLUDED.local_id, updated_at = now()`,
      [businessId, connection.id, String(product.id), itemId],
    );
    await client.query("COMMIT");
    return "created";
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Upsert a retail item's on-hand quantity and shelf price (Rial). */
async function upsertItemStock(itemId: string, quantity: number, price: bigint): Promise<void> {
  await query(
    `INSERT INTO item_stock (item_id, quantity, unit_price)
     VALUES ($1, $2, $3)
     ON CONFLICT (item_id) DO UPDATE
       SET quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, updated_at = now()`,
    [itemId, quantity, price > 0n ? Number(price) : null],
  );
}

/** Replace a variation's attribute set (idempotent on re-delivery). */
async function replaceVariantAttributes(itemId: string, attributes: WooVariationAttribute[]): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM item_variant_attributes WHERE item_id = $1`, [itemId]);
    for (const attr of attributes) {
      if (!attr.name || !attr.option) continue;
      await client.query(
        `INSERT INTO item_variant_attributes (item_id, name, value) VALUES ($1, $2, $3)`,
        [itemId, attr.name, attr.option],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** One WooCommerce customer -> one local `customers` row. Same two-callers reasoning as above. */
export async function upsertCustomerFromWoo(
  connection: ConnectionRow,
  customer: WooCustomer,
): Promise<"created" | "updated"> {
  const businessId = connection.business_id;
  const name =
    `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim() || customer.email || `Customer #${customer.id}`;
  const phone = customer.billing?.phone?.trim() || null;
  const address = customer.billing?.address_1?.trim() || null;
  const existing = await localIdForRemote(businessId, connection.id, "customer", String(customer.id));
  if (existing) {
    await query(
      `UPDATE customers SET name = $3, phone = $4, address = $5, updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [existing, businessId, name, phone, address],
    );
    return "updated";
  }
  const { rows } = await query<{ id: string }>(
    `INSERT INTO customers (business_id, name, phone, address)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [businessId, name, phone, address],
  );
  await upsertMapping(businessId, connection.id, "customer", String(customer.id), rows[0].id);
  return "created";
}

export async function syncProducts(businessId: string, connectionId: string): Promise<SyncOutcome> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");
  const client = wooClientFor(connection);
  const locationId = await resolveLocationId(businessId, connection.location_id);

  let created = 0;
  let updated = 0;
  let page = 1;
  let total = 0;

  for (;;) {
    const products: WooProduct[] = await client.listProducts({ per_page: PER_PAGE, page });
    total += products.length;
    for (const product of products) {
      try {
        if ((await upsertProductFromWoo(connection, locationId, product)) === "created") created += 1;
        else updated += 1;
      } catch (err) {
        // A variation can arrive before its parent in a paged pull; failing the
        // whole sync over it would also lose every product after it in the page.
        // Log and keep going — the next sync (or the same one, once the parent
        // is inserted earlier in the list) retries this one.
        await writeIntegrationAudit({
          businessId,
          connectionId,
          action: "product.sync_failed",
          entityType: "product",
          remoteId: String(product.id),
          error: (err as Error).message,
        });
      }
    }
    if (products.length < PER_PAGE) break;
    page += 1;
  }

  await query(
    `UPDATE integration_connections SET last_sync_at = now(), status = 'active', last_error = NULL, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, connectionId],
  );
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "products.synced",
    payload: { created, updated, total },
  });
  return { created, updated, total };
}

export async function syncCustomers(businessId: string, connectionId: string): Promise<SyncOutcome> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");
  const client = wooClientFor(connection);

  let created = 0;
  let updated = 0;
  let page = 1;
  let total = 0;

  for (;;) {
    const customers: WooCustomer[] = await client.listCustomers({ per_page: PER_PAGE, page });
    total += customers.length;
    for (const customer of customers) {
      if ((await upsertCustomerFromWoo(connection, customer)) === "created") created += 1;
      else updated += 1;
    }
    if (customers.length < PER_PAGE) break;
    page += 1;
  }

  await query(
    `UPDATE integration_connections SET last_sync_at = now(), status = 'active', last_error = NULL, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, connectionId],
  );
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "customers.synced",
    payload: { created, updated, total },
  });
  return { created, updated, total };
}

/** All mapped products for a connection, joined with their local price (Rial).
 * Queries whichever table the business's industry actually uses. */
export async function mappedProducts(
  businessId: string,
  connectionId: string,
): Promise<{ remoteId: string; localId: string; name: string; priceRial: bigint }[]> {
  const mappings = await listMappings(businessId, connectionId, "product");
  if (mappings.length === 0) return [];
  const ids = mappings.map((m) => m.localId);
  const industry = await getBusinessIndustry(businessId);

  if (industry === "food_service") {
    const { rows } = await query<{ id: string; name: string; price: string }>(
      `SELECT id, name, price FROM menu_items WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return mappings.flatMap((m) => {
      const item = byId.get(m.localId);
      return item ? [{ remoteId: m.remoteId, localId: m.localId, name: item.name, priceRial: BigInt(item.price) }] : [];
    });
  }

  // Retail: items + item_stock. A variant_parent has no sellable price; its
  // children (and simple items) do.
  const { rows } = await query<{ id: string; name: string; unit_price: string | null }>(
    `SELECT i.id, i.name, s.unit_price::text
       FROM items i
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE i.id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return mappings.flatMap((m) => {
    const item = byId.get(m.localId);
    return item && item.unit_price
      ? [{ remoteId: m.remoteId, localId: m.localId, name: item.name, priceRial: BigInt(item.unit_price) }]
      : [];
  });
}
