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
import { generatePluginToken, hashPluginToken } from "./plugin-link";
import { createWooCommerceClient, type WooCredentials } from "./woocommerce-client";
import type { WooCurrencyUnit } from "./woo-money";
import { writeIntegrationAudit } from "./audit";

/**
 * How a store is connected.
 *
 * `rest_api` is migration 0070's original shape: the owner pastes WooCommerce
 * consumer keys, the app calls the store, and the store calls back with
 * webhooks. `plugin` is migration 0076's: a WordPress plugin holds one
 * integration-scoped token, signs every request with it, and does all the
 * calling in both directions. See migrations/0076_wordpress_plugin_link.sql
 * for why both are kept.
 */
export type LinkMode = "rest_api" | "plugin";

export interface ConnectionRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  name: string;
  provider: string;
  base_url: string;
  link_mode: LinkMode;
  consumer_key_ciphertext: string | null;
  consumer_secret_ciphertext: string | null;
  webhook_secret_ciphertext: string;
  link_token_hash: string | null;
  link_token_ciphertext: string | null;
  link_token_set_at: string | null;
  plugin_version: string | null;
  plugin_site_url: string | null;
  last_plugin_seen_at: string | null;
  currency_unit: WooCurrencyUnit;
  sync_orders: boolean;
  sync_products: boolean;
  sync_customers: boolean;
  push_stock: boolean;
  push_prices: boolean;
  /** Phase 38 — mirror the store's product_cat into the local menu (F&B). */
  sync_categories: boolean;
  /** Phase 38 — pull recent orders on a schedule, not only by webhook. */
  auto_pull_orders: boolean;
  /** How far back a scheduled order pull looks, in days. */
  order_lookback_days: number;
  status: "active" | "paused" | "error";
  last_sync_at: string | null;
  /** Phase 38 — split from last_sync_at: the two jobs fail independently. */
  last_catalogue_sync_at: string | null;
  last_order_sync_at: string | null;
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
  linkMode: LinkMode;
  currencyUnit: WooCurrencyUnit;
  syncOrders: boolean;
  syncProducts: boolean;
  syncCustomers: boolean;
  pushStock: boolean;
  pushPrices: boolean;
  syncCategories: boolean;
  autoPullOrders: boolean;
  orderLookbackDays: number;
  status: "active" | "paused" | "error";
  lastSyncAt: string | null;
  lastCatalogueSyncAt: string | null;
  lastOrderSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /** The path this store's webhook must be configured to deliver to (rest_api mode only). */
  webhookPath: string;
  /** Whether a link token has been issued for this connection at all. Never the token. */
  hasLinkToken: boolean;
  linkTokenSetAt: string | null;
  pluginVersion: string | null;
  pluginSiteUrl: string | null;
  /** The last time the plugin authenticated — the only real "is it alive?" signal in plugin mode. */
  lastPluginSeenAt: string | null;
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
    linkMode: row.link_mode,
    currencyUnit: row.currency_unit,
    syncOrders: row.sync_orders,
    syncProducts: row.sync_products,
    syncCustomers: row.sync_customers,
    pushStock: row.push_stock,
    pushPrices: row.push_prices,
    syncCategories: row.sync_categories,
    autoPullOrders: row.auto_pull_orders,
    orderLookbackDays: row.order_lookback_days,
    status: row.status,
    lastSyncAt: row.last_sync_at,
    lastCatalogueSyncAt: row.last_catalogue_sync_at,
    lastOrderSyncAt: row.last_order_sync_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    webhookPath: webhookPathFor(row.id),
    hasLinkToken: Boolean(row.link_token_hash),
    linkTokenSetAt: row.link_token_set_at,
    pluginVersion: row.plugin_version,
    pluginSiteUrl: row.plugin_site_url,
    lastPluginSeenAt: row.last_plugin_seen_at,
  };
}

export const CONNECTION_COLUMNS = `id, business_id, location_id, name, provider, base_url,
  link_mode, consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
  link_token_hash, link_token_ciphertext, link_token_set_at,
  plugin_version, plugin_site_url, last_plugin_seen_at,
  currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices,
  sync_categories, auto_pull_orders, order_lookback_days,
  status, last_sync_at, last_catalogue_sync_at, last_order_sync_at, last_error, created_at, updated_at`;

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
  /** Which of the two link modes; omitted means the original REST/consumer-key shape. */
  linkMode?: LinkMode;
  /** Required in `rest_api` mode, ignored in `plugin` mode. */
  consumerKey?: string;
  consumerSecret?: string;
  currencyUnit: WooCurrencyUnit;
  locationId?: string | null;
  syncOrders?: boolean;
  syncProducts?: boolean;
  syncCustomers?: boolean;
  pushStock?: boolean;
  pushPrices?: boolean;
  /** Phase 38 — mirror the store's categories into the local menu. Opt-in. */
  syncCategories?: boolean;
  /** Phase 38 — scheduled order pull, in addition to webhooks. */
  autoPullOrders?: boolean;
  orderLookbackDays?: number;
}

export type CreateConnectionResult =
  | {
      ok: true;
      connection: Connection;
      /** Shown once. In plugin mode this is the store's own webhook secret and stays unused. */
      webhookSecret: string;
      /** Shown once, and only in plugin mode: what the owner pastes into the WordPress plugin. */
      linkToken?: string;
    }
  | { ok: false; error: string };

const URL_RE = /^https?:\/\/[^\s]+$/;

export async function createConnection(
  businessId: string,
  createdBy: string,
  input: CreateConnectionInput,
): Promise<CreateConnectionResult> {
  const name = input.name.trim();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const linkMode: LinkMode = input.linkMode === "plugin" ? "plugin" : "rest_api";
  if (!name || name.length > 120) return { ok: false, error: "invalid_name" };
  if (!URL_RE.test(baseUrl)) return { ok: false, error: "invalid_base_url" };
  // Consumer keys are what a rest_api connection *is*; a plugin connection has
  // no use for them and must not be made to invent a pair.
  if (linkMode === "rest_api" && (!input.consumerKey?.trim() || !input.consumerSecret?.trim())) {
    return { ok: false, error: "missing_credentials" };
  }
  if (input.currencyUnit !== "rial" && input.currencyUnit !== "toman") {
    return { ok: false, error: "invalid_currency_unit" };
  }

  const key = resolveEncryptionKey(process.env);
  const webhookSecret = randomBytes(32).toString("base64url");
  const linkToken = linkMode === "plugin" ? generatePluginToken() : null;
  const { rows } = await query<ConnectionRow>(
    `INSERT INTO integration_connections
       (business_id, location_id, name, base_url, link_mode,
        consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
        link_token_hash, link_token_ciphertext, link_token_set_at,
        currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             CASE WHEN $9::text IS NULL THEN NULL ELSE now() END,
             $11, $12, $13, $14, $15, $16, $17)
     RETURNING ${CONNECTION_COLUMNS}`,
    [
      businessId,
      input.locationId ?? null,
      name,
      baseUrl,
      linkMode,
      linkMode === "rest_api" ? encryptSecret(input.consumerKey!.trim(), key) : null,
      linkMode === "rest_api" ? encryptSecret(input.consumerSecret!.trim(), key) : null,
      encryptSecret(webhookSecret, key),
      linkToken ? hashPluginToken(linkToken) : null,
      linkToken ? encryptSecret(linkToken, key) : null,
      input.currencyUnit,
      input.syncOrders ?? true,
      input.syncProducts ?? true,
      input.syncCustomers ?? true,
      input.pushStock ?? true,
      input.pushPrices ?? true,
      input.syncCategories ?? false,
      input.autoPullOrders ?? true,
      Math.min(365, Math.max(1, Math.round(input.orderLookbackDays ?? 7))),
      createdBy,
    ],
  );
  await writeIntegrationAudit({
    businessId,
    connectionId: rows[0].id,
    action: "connection.created",
    payload: { name, baseUrl, linkMode, currencyUnit: input.currencyUnit },
  });
  return {
    ok: true,
    connection: mapConnection(rows[0]),
    webhookSecret,
    ...(linkToken ? { linkToken } : {}),
  };
}

/**
 * Mint a fresh link token for a plugin connection, invalidating the old one.
 *
 * Rotation is a break in service by design — the plugin stops authenticating
 * the instant this returns and resumes when the new token is pasted in — which
 * is what makes it useful after a WordPress compromise. Nothing queued is
 * lost: the outbox rows the plugin had not yet acked simply wait.
 */
export async function rotateLinkToken(
  businessId: string,
  id: string,
): Promise<{ ok: true; linkToken: string } | { ok: false; error: "not_found" | "not_plugin_mode" }> {
  const existing = await getConnection(businessId, id);
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.link_mode !== "plugin") return { ok: false, error: "not_plugin_mode" };

  const key = resolveEncryptionKey(process.env);
  const linkToken = generatePluginToken();
  await query(
    `UPDATE integration_connections
        SET link_token_hash = $3, link_token_ciphertext = $4, link_token_set_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, id, hashPluginToken(linkToken), encryptSecret(linkToken, key)],
  );
  await writeIntegrationAudit({ businessId, connectionId: id, action: "connection.link_token_rotated" });
  return { ok: true, linkToken };
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
  syncCategories?: boolean;
  autoPullOrders?: boolean;
  orderLookbackDays?: number;
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
  if (input.syncCategories !== undefined) add("sync_categories", input.syncCategories);
  if (input.autoPullOrders !== undefined) add("auto_pull_orders", input.autoPullOrders);
  if (input.orderLookbackDays !== undefined) {
    add("order_lookback_days", Math.min(365, Math.max(1, Math.round(input.orderLookbackDays))));
  }
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

/**
 * Decrypts a connection's credentials and returns a ready-to-use client.
 *
 * Throws in plugin mode rather than returning null: there are no consumer keys
 * there *by design*, so any code path that reaches this has assumed the wrong
 * link mode, and a thrown error names that at the point of the mistake instead
 * of producing an unauthenticated request against the store.
 */
export function wooClientFor(connection: ConnectionRow) {
  if (connection.link_mode !== "rest_api" || !connection.consumer_key_ciphertext || !connection.consumer_secret_ciphertext) {
    throw new Error("no_rest_credentials");
  }
  const key = resolveEncryptionKey(process.env);
  const credentials: WooCredentials = {
    baseUrl: connection.base_url,
    consumerKey: decryptSecret(connection.consumer_key_ciphertext, key),
    consumerSecret: decryptSecret(connection.consumer_secret_ciphertext, key),
  };
  return createWooCommerceClient(credentials);
}

/**
 * The plugin's link token in plaintext, for verifying an inbound request's
 * HMAC. Null when this connection has none (a rest_api connection, or one
 * whose token was never issued).
 */
export function linkTokenFor(connection: ConnectionRow): string | null {
  if (!connection.link_token_ciphertext) return null;
  return decryptSecret(connection.link_token_ciphertext, resolveEncryptionKey(process.env));
}

/** Decrypts the webhook secret used to verify inbound delivery signatures. */
export function webhookSecretFor(connection: ConnectionRow): string {
  return decryptSecret(connection.webhook_secret_ciphertext, resolveEncryptionKey(process.env));
}

/**
 * Connection test, in whichever direction this connection actually runs.
 *
 * `rest_api`: a 1-page products read proves the credentials and the store's
 * reachability, because in that mode the app is the caller.
 *
 * `plugin`: the app never dials the store, so there is nothing to call. What
 * "connected" means there is that the plugin has authenticated recently — so
 * that is what is reported, together with the last time it did. The plugin's
 * own «آزمایش اتصال» button is the active half of this test: it calls
 * /api/integrations/wordpress/ping, which updates exactly this timestamp.
 */
export async function testConnection(
  businessId: string,
  id: string,
): Promise<{ ok: boolean; error?: string; lastSeenAt?: string | null }> {
  const connection = await getConnection(businessId, id);
  if (!connection) return { ok: false, error: "not_found" };

  if (connection.link_mode === "plugin") {
    const seen = connection.last_plugin_seen_at;
    await writeIntegrationAudit({
      businessId,
      connectionId: id,
      action: seen ? "connection.test_ok" : "connection.test_failed",
      error: seen ? undefined : "plugin_never_connected",
    });
    return seen
      ? { ok: true, lastSeenAt: seen }
      : { ok: false, error: "plugin_never_connected", lastSeenAt: null };
  }

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
