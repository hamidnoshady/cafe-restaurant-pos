/**
 * Phase 23 (issue #118) — Wave 3: pull products and customers from a
 * WooCommerce store into the local menu/customer directory, remembering each
 * remote id in integration_mappings. DB-touching (not unit-tested directly).
 *
 * Products become `menu_items` (finished goods the store sells); category and
 * modifier mapping are deliberately out of scope for this wave, so items are
 * created category-less and can be filed later by hand.
 */
import { query } from "../db";
import { getConnection, wooClientFor } from "./connections-service";
import { listMappings, localIdForRemote, upsertMapping } from "./mapping-service";
import { wooAmountToRial } from "./woo-money";
import { writeIntegrationAudit } from "./audit";
import type { WooCustomer, WooProduct } from "./woocommerce-client";

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
      const price = wooAmountToRial(product.regular_price || product.price || "0", connection.currency_unit);
      const existing = await localIdForRemote(businessId, connectionId, "product", String(product.id));
      if (existing) {
        await query(
          `UPDATE menu_items SET name = $3, sku = $4, price = $5, updated_at = now()
            WHERE id = $1 AND location_id = $2`,
          [existing, locationId, product.name, product.sku || null, price.toString()],
        );
        updated += 1;
      } else {
        const { rows } = await query<{ id: string }>(
          `INSERT INTO menu_items (location_id, name, sku, price)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [locationId, product.name, product.sku || null, price.toString()],
        );
        await upsertMapping(businessId, connectionId, "product", String(product.id), rows[0].id);
        created += 1;
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
      const name = `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim() || customer.email || `Customer #${customer.id}`;
      const phone = customer.billing?.phone?.trim() || null;
      const address = customer.billing?.address_1?.trim() || null;
      const existing = await localIdForRemote(businessId, connectionId, "customer", String(customer.id));
      if (existing) {
        await query(
          `UPDATE customers SET name = $3, phone = $4, address = $5, updated_at = now()
            WHERE id = $1 AND business_id = $2`,
          [existing, businessId, name, phone, address],
        );
        updated += 1;
      } else {
        const { rows } = await query<{ id: string }>(
          `INSERT INTO customers (business_id, name, phone, address)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [businessId, name, phone, address],
        );
        await upsertMapping(businessId, connectionId, "customer", String(customer.id), rows[0].id);
        created += 1;
      }
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

/** All mapped products for a connection, joined with their local price. */
export async function mappedProducts(
  businessId: string,
  connectionId: string,
): Promise<{ remoteId: string; localId: string; name: string; priceRial: bigint }[]> {
  const mappings = await listMappings(businessId, connectionId, "product");
  if (mappings.length === 0) return [];
  const ids = mappings.map((m) => m.localId);
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
