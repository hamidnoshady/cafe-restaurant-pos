/**
 * Phase 23 (issue #118) — the Integration Gateway: the only place in the app
 * that talks to a WooCommerce store.
 *
 * Credentials are sent as HTTP Basic auth (consumer key = username, consumer
 * secret = password), WooCommerce REST API v3's recommended scheme. The URL
 * and auth-header construction is pure (unit-tested); `fetch` is injectable
 * so tests never touch the network and the background outbox tick can pass a
 * shared client around.
 */

export interface WooCredentials {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

export interface WooProduct {
  id: number;
  name: string;
  sku: string;
  price: string;
  regular_price: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  status: string;
}

export interface WooCustomer {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  billing?: { phone?: string; address_1?: string };
}

export interface WooOrderLineItem {
  id: number;
  name: string;
  product_id: number;
  quantity: number;
  price: string;
  total: string;
}

export interface WooOrder {
  id: number;
  number: string;
  status: string;
  total: string;
  total_tax: string;
  currency: string;
  date_created: string;
  payment_method: string;
  line_items: WooOrderLineItem[];
  billing?: { first_name?: string; last_name?: string; phone?: string; email?: string };
  shipping?: { address_1?: string; city?: string };
}

export interface WooRefundLineItem {
  product_id: number;
  /** Negative for refunds (the WooCommerce convention). */
  quantity: number;
  /** Negative for refunds. */
  total: string;
}

export interface WooRefund {
  id: number;
  /** The order the refund belongs to. */
  parent_id: number;
  date_created: string;
  amount: string;
  total_tax?: string;
  reason: string;
  line_items?: WooRefundLineItem[];
}

export interface WooList<T> {
  items: T[];
  totalPages: number;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class WooCommerceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** `consumerKey:consumerSecret` in base64 — the Basic auth credential. */
export function wooAuthHeader(credentials: WooCredentials): string {
  return `Basic ${Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString("base64")}`;
}

/** The REST API URL for a path, keeping the store's base exactly as given. */
export function wooApiUrl(baseUrl: string, path: string, query?: Record<string, string | number | boolean>): string {
  const base = baseUrl.replace(/\/+$/, "");
  const endpoint = `/wp-json/wc/v3/${path.replace(/^\/+/, "")}`;
  if (!query) return `${base}${endpoint}`;
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `${base}${endpoint}?${qs}` : `${base}${endpoint}`;
}

async function request<T>(
  credentials: WooCredentials,
  fetchImpl: FetchLike,
  method: string,
  path: string,
  options: { query?: Record<string, string | number | boolean>; body?: unknown } = {},
): Promise<T> {
  const response = await fetchImpl(wooApiUrl(credentials.baseUrl, path, options.query), {
    method,
    headers: {
      Authorization: wooAuthHeader(credentials),
      "Content-Type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const json = (await response.json()) as T & { code?: string; message?: string };
  if (!response.ok) {
    throw new WooCommerceError(json?.message ?? `woocommerce_${method.toLowerCase()}_failed`, response.status);
  }
  return json as T;
}

export interface WooCommerceClient {
  listProducts(query?: Record<string, string | number | boolean>): Promise<WooProduct[]>;
  getProduct(id: number): Promise<WooProduct>;
  updateProduct(id: number, patch: Record<string, unknown>): Promise<WooProduct>;
  listOrders(query?: Record<string, string | number | boolean>): Promise<WooOrder[]>;
  listRefunds(query?: Record<string, string | number | boolean>): Promise<WooRefund[]>;
  listCustomers(query?: Record<string, string | number | boolean>): Promise<WooCustomer[]>;
}

export function createWooCommerceClient(
  credentials: WooCredentials,
  fetchImpl: FetchLike = (url, init) => fetch(url, init).then((r) => ({ ok: r.ok, status: r.status, json: () => r.json() })),
): WooCommerceClient {
  const get = <T>(path: string, query?: Record<string, string | number | boolean>) =>
    request<T>(credentials, fetchImpl, "GET", path, { query });

  return {
    listProducts: (query) => get<WooProduct[]>("products", query),
    getProduct: (id) => get<WooProduct>(`products/${id}`),
    updateProduct: (id, patch) =>
      request<WooProduct>(credentials, fetchImpl, "PUT", `products/${id}`, { body: patch }),
    listOrders: (query) => get<WooOrder[]>("orders", query),
    listRefunds: (query) => get<WooRefund[]>("refunds", query),
    listCustomers: (query) => get<WooCustomer[]>("customers", query),
  };
}
