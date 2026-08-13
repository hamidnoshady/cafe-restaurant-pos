/**
 * Phase 23 (issue #118) — Wave 1: WooCommerce connection lifecycle.
 * DB-touching (not unit-tested directly, per repo convention; the pure crypto
 * and money conversion it leans on are covered by their own tests).
 *
 * Secrets are encrypted at rest (secrets.ts) and never returned by the list
 * endpoint; the only time the plaintext leaves the process is inside the
 * outbound HTTP client's Basic auth header. A newly created connection returns
 * its webhook secret exactly once (the same show-once pattern as an API key).
 */
import { randomBytes } from "node:crypto";
import { query } from "../db";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "./secrets";
import { createWooCommerceClient, type WooCredentials } from "./woocommerce-client";
import type { WooCurrencyUnit } from "./woo-money";
import { writeIntegrationAudit } from "./audit";

export interface ConnectionRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  name: string;
  provider: string;
  base_url: string;
  consumer_key_ciphertext: string;
  consumer_secret_ciphertext: string;
  webhook_secret_ciphertext: string;
  currency_unit: WooCurrencyUnit;
  sync_orders: boolean;
  sync_products: boolean;
  sync_customers: boolean;
  push_stock: boolean;
  push_prices: boolean;
  status: "active" | "paused" | "error";
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** The safe, secret-free shape returned to the dashboard and routes. */
export interface Connection {
  id: string;
  businessId: string;
  locationId: string | null;
  name: string;
  provider: string;
  baseUrl: string;
  currencyUnit: WooCurrencyUnit;
  syncOrders: boolean;
  syncProducts: boolean;
  syncCustomers: boolean;
  pushStock: boolean;
  pushPrices: boolean;
  status: "active" | "paused" | "error";
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /** The path this store's webhook must be configured to deliver to. */
  webhookPath: string;
}

export function webhookPathFor(connectionId: string): string {
  return `/api/integrations/woocommerce/webhook/${connectionId}`;
}

function mapConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.base_url,
    currencyUnit: row.currency_unit,
    syncOrders: row.sync_orders,
    syncProducts: row.sync_products,
    syncCustomers: row.sync_customers,
    pushStock: row.push_stock,
    pushPrices: row.push_prices,
    status: row.status,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    webhookPath: webhookPathFor(row.id),
  };
}

export const CONNECTION_COLUMNS = `id, business_id, location_id, name, provider, base_url,
  consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
  currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices,
  status, last_sync_at, last_error, created_at, updated_at`;

export async function listConnections(businessId: string): Promise<Connection[]> {
  const { rows } = await query<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM integration_connections WHERE business_id = $1 ORDER BY created_at`,
    [businessId],
  );
  return rows.map(mapConnection);
}

export async function getConnection(businessId: string, id: string): Promise<ConnectionRow | null> {
  const { rows } = await query<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM integration_connections WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ?? null;
}

export interface CreateConnectionInput {
  name: string;
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  currencyUnit: WooCurrencyUnit;
  locationId?: string | null;
  syncOrders?: boolean;
  syncProducts?: boolean;
  syncCustomers?: boolean;
  pushStock?: boolean;
  pushPrices?: boolean;
}

export type CreateConnectionResult =
  | { ok: true; connection: Connection; webhookSecret: string }
  | { ok: false; error: string };

const URL_RE = /^https?:\/\/[^\s]+$/;

export async function createConnection(
  businessId: string,
  createdBy: string,
  input: CreateConnectionInput,
): Promise<CreateConnectionResult> {
  const name = input.name.trim();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (!name || name.length > 120) return { ok: false, error: "invalid_name" };
  if (!URL_RE.test(baseUrl)) return { ok: false, error: "invalid_base_url" };
  if (!input.consumerKey.trim() || !input.consumerSecret.trim()) {
    return { ok: false, error: "missing_credentials" };
  }
  if (input.currencyUnit !== "rial" && input.currencyUnit !== "toman") {
    return { ok: false, error: "invalid_currency_unit" };
  }

  const key = resolveEncryptionKey(process.env);
  const webhookSecret = randomBytes(32).toString("base64url");
  const { rows } = await query<ConnectionRow>(
    `INSERT INTO integration_connections
       (business_id, location_id, name, base_url,
        consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
        currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${CONNECTION_COLUMNS}`,
    [
      businessId,
      input.locationId ?? null,
      name,
      baseUrl,
      encryptSecret(input.consumerKey.trim(), key),
      encryptSecret(input.consumerSecret.trim(), key),
      encryptSecret(webhookSecret, key),
      input.currencyUnit,
      input.syncOrders ?? true,
      input.syncProducts ?? true,
      input.syncCustomers ?? true,
      input.pushStock ?? true,
      input.pushPrices ?? true,
      createdBy,
    ],
  );
  await writeIntegrationAudit({
    businessId,
    connectionId: rows[0].id,
    action: "connection.created",
    payload: { name, baseUrl, currencyUnit: input.currencyUnit },
  });
  return { ok: true, connection: mapConnection(rows[0]), webhookSecret };
}

export interface UpdateConnectionInput {
  name?: string;
  locationId?: string | null;
  status?: "active" | "paused";
  syncOrders?: boolean;
  syncProducts?: boolean;
  syncCustomers?: boolean;
  pushStock?: boolean;
  pushPrices?: boolean;
  /** New credentials, only when the owner is re-authenticating the store. */
  consumerKey?: string;
  consumerSecret?: string;
}

export async function updateConnection(
  businessId: string,
  id: string,
  input: UpdateConnectionInput,
): Promise<{ ok: true; connection: Connection } | { ok: false; error: string }> {
  const existing = await getConnection(businessId, id);
  if (!existing) return { ok: false, error: "not_found" };

  const key = resolveEncryptionKey(process.env);
  const sets: string[] = [];
  const params: unknown[] = [businessId, id];
  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > 120) return { ok: false, error: "invalid_name" };
    add("name", name);
  }
  if (input.locationId !== undefined) add("location_id", input.locationId);
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "paused") return { ok: false, error: "invalid_status" };
    add("status", input.status);
  }
  if (input.syncOrders !== undefined) add("sync_orders", input.syncOrders);
  if (input.syncProducts !== undefined) add("sync_products", input.syncProducts);
  if (input.syncCustomers !== undefined) add("sync_customers", input.syncCustomers);
  if (input.pushStock !== undefined) add("push_stock", input.pushStock);
  if (input.pushPrices !== undefined) add("push_prices", input.pushPrices);
  if (input.consumerKey !== undefined) add("consumer_key_ciphertext", encryptSecret(input.consumerKey.trim(), key));
  if (input.consumerSecret !== undefined) add("consumer_secret_ciphertext", encryptSecret(input.consumerSecret.trim(), key));
  if (sets.length === 0) return { ok: true, connection: mapConnection(existing) };

  const { rows } = await query<ConnectionRow>(
    `UPDATE integration_connections SET ${sets.join(", ")}, updated_at = now()
      WHERE business_id = $1 AND id = $2
      RETURNING ${CONNECTION_COLUMNS}`,
    params,
  );
  await writeIntegrationAudit({ businessId, connectionId: id, action: "connection.updated", payload: input });
  return { ok: true, connection: mapConnection(rows[0]) };
}

export async function deleteConnection(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM integration_connections WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  if (rowCount === 1) {
    await writeIntegrationAudit({ businessId, connectionId: id, action: "connection.deleted" });
  }
  return rowCount === 1;
}

/** Decrypts a connection's credentials and returns a ready-to-use client. */
export function wooClientFor(connection: ConnectionRow) {
  const key = resolveEncryptionKey(process.env);
  const credentials: WooCredentials = {
    baseUrl: connection.base_url,
    consumerKey: decryptSecret(connection.consumer_key_ciphertext, key),
    consumerSecret: decryptSecret(connection.consumer_secret_ciphertext, key),
  };
  return createWooCommerceClient(credentials);
}

/** Decrypts the webhook secret used to verify inbound delivery signatures. */
export function webhookSecretFor(connection: ConnectionRow): string {
  return decryptSecret(connection.webhook_secret_ciphertext, resolveEncryptionKey(process.env));
}

/** Wave 1's connection test: a 1-page products read proves credentials + reachability. */
export async function testConnection(
  businessId: string,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const connection = await getConnection(businessId, id);
  if (!connection) return { ok: false, error: "not_found" };
  try {
    await wooClientFor(connection).listProducts({ per_page: 1 });
    await query(
      `UPDATE integration_connections SET status = 'active', last_sync_at = now(), last_error = NULL, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [businessId, id],
    );
    await writeIntegrationAudit({ businessId, connectionId: id, action: "connection.test_ok" });
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message;
    await query(
      `UPDATE integration_connections SET status = 'error', last_error = $3, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [businessId, id, message],
    );
    await writeIntegrationAudit({ businessId, connectionId: id, action: "connection.test_failed", error: message });
    return { ok: false, error: message };
  }
}
