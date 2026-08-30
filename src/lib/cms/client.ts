/**
 * Eshobe CMS — the REST client (headless site builder integration).
 *
 * This is the *only* module in the app that talks to the Payload CMS over
 * HTTP, mirroring the rule `woocommerce-client.ts` established for the
 * WooCommerce storefront: URL building, auth header construction and error
 * mapping are pure and unit-tested; `fetch` is injectable so tests never
 * touch the network and the caller can pass its own timeout/AbortSignal.
 *
 * ## How the tenant is chosen (the hard rule)
 *
 * The CMS resolves the tenant from the request's `Host` header or from a
 * per-site API key (`Authorization: Bearer eshobe_live_…`) — never from a
 * query filter (WAVE-9 §1/§6 of the eshobe-cms repo). So a `CmsConfig`
 * always carries the customer site's domain; we forward it as the `Host`
 * header even when the API is reached through the CMS's control-plane
 * origin. A caller that could pick `?where[site][equals]=…` and change the
 * tenant would be able to read another customer's content.
 *
 * ## Auth model
 *
 * - `role: "site"` key — full read + write for ONE site (content, catalogue,
 *   orders). Issued per customer website, stored encrypted per business.
 * - `role: "platform"` key — site provisioning and API-key lifecycle only
 *   (`POST /api/provision-site`, `/api/site-api-keys`); it is the operator
 *   console's credential and never reads site content.
 */
import type {
  ApiKeySummary,
  CmsCategory,
  CmsLocale,
  CmsMedia,
  CmsOrder,
  CmsPage,
  CmsPost,
  CmsProduct,
  CmsSite,
  CmsStore,
  IssuedApiKey,
  PayloadList,
  ProvisionSiteInput,
  ProvisionSiteResult,
  SiteDescriptor,
} from "./types";

export interface CmsConfig {
  /** CMS control-plane origin, e.g. `https://cms.eshobe.com`. No trailing slash. */
  baseUrl: string;
  /** The customer site's domain — forwarded as `Host`; this IS the tenant. */
  siteDomain?: string;
  /** Per-site (`eshobe_live_…`) or platform API key. */
  apiKey?: string;
  timeoutMs?: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CmsRequestOptions<Body = unknown> {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** API path including the `/api` prefix, e.g. `/api/products`. */
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: Body;
  /** Extra headers (e.g. `content-type` for uploads). */
  headers?: Record<string, string>;
  fetchImpl?: FetchLike;
}

/** Payload REST error body (`{ message, errors? }` — errors carry field details). */
export interface CmsApiErrorBody {
  message?: string;
  errors?: { message: string; field?: string; path?: string }[];
  [key: string]: unknown;
}

export class CmsApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: CmsApiErrorBody;

  constructor(status: number, path: string, body: CmsApiErrorBody) {
    super(body?.message ?? `Eshobe CMS request failed (${status}): ${path}`);
    this.name = "CmsApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export class CmsNetworkError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.name = "CmsNetworkError";
    this.path = path;
  }
}

/** Normalise the origin: strip trailing slash, reject relative URLs. */
export function normalizeCmsBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error(`ESHOBE_CMS_URL must be an absolute http(s) URL, got "${baseUrl}"`);
  }
  return trimmed;
}

/** Build the query string for Payload's REST `where` filters and paging. */
export function cmsQueryString(query?: CmsRequestOptions["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

/** Build the final URL. Separated from `cmsRequest` so tests can pin it. */
export function cmsUrl(config: Pick<CmsConfig, "baseUrl">, options: CmsRequestOptions): string {
  return `${normalizeCmsBaseUrl(config.baseUrl)}${options.path}${cmsQueryString(options.query)}`;
}

/**
 * Headers for one CMS call. `Host` carries the tenant — it is a normal HTTP
 * header server-to-server, and the CMS's access layer consults it exactly
 * once per request (memoised on `req.context`).
 */
export function cmsHeaders(config: CmsConfig, options: CmsRequestOptions): Headers {
  const headers = new Headers(options.headers);
  if (config.siteDomain) headers.set("Host", config.siteDomain);
  if (config.apiKey) headers.set("Authorization", `Bearer ${config.apiKey}`);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** The single HTTP entry point. Throws `CmsApiError` / `CmsNetworkError`. */
export async function cmsRequest<T>(
  config: CmsConfig,
  options: CmsRequestOptions,
): Promise<T> {
  const url = cmsUrl(config, options);
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: options.method ?? "GET",
      headers: cmsHeaders(config, options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CmsNetworkError(`Eshobe CMS unreachable (${url}): ${reason}`, options.path);
  }

  const text = await response.text();
  const body = text
    ? (JSON.parse(text) as CmsApiErrorBody | unknown)
    : undefined;

  if (!response.ok) {
    throw new CmsApiError(
      response.status,
      options.path,
      (body ?? {}) as CmsApiErrorBody,
    );
  }

  return body as T;
}

/** Payload `where` filter for one value (safe to narrow with, never to widen). */
export function whereEquals(field: string, value: string): Record<string, unknown> {
  return { [field]: { equals: value } };
}

/* ------------------------------------------------------------------ */
/* Site-level reads — a `role: "site"` key (or an anonymous host call) */
/* ------------------------------------------------------------------ */

/** `GET /api/site` — what a renderer needs before first paint. */
export function fetchSiteDescriptor(config: CmsConfig, opts?: { fetchImpl?: FetchLike }): Promise<SiteDescriptor> {
  return cmsRequest<SiteDescriptor>(config, { path: "/api/site", fetchImpl: opts?.fetchImpl });
}

export function fetchPages(
  config: CmsConfig,
  opts?: { locale?: CmsLocale; slug?: string; limit?: number; page?: number; depth?: number; fetchImpl?: FetchLike },
): Promise<PayloadList<CmsPage>> {
  return cmsRequest<PayloadList<CmsPage>>(config, {
    path: "/api/pages",
    query: {
      locale: opts?.locale,
      limit: opts?.limit ?? 100,
      page: opts?.page,
      depth: opts?.depth ?? 0,
      ...(opts?.slug ? { "where[slug][equals]": opts.slug } : {}),
    },
    fetchImpl: opts?.fetchImpl,
  });
}

export function fetchPosts(
  config: CmsConfig,
  opts?: { locale?: CmsLocale; slug?: string; limit?: number; page?: number; fetchImpl?: FetchLike },
): Promise<PayloadList<CmsPost>> {
  return cmsRequest<PayloadList<CmsPost>>(config, {
    path: "/api/posts",
    query: {
      locale: opts?.locale,
      limit: opts?.limit ?? 100,
      page: opts?.page,
      ...(opts?.slug ? { "where[slug][equals]": opts.slug } : {}),
    },
    fetchImpl: opts?.fetchImpl,
  });
}

export function fetchCategories(
  config: CmsConfig,
  opts?: { locale?: CmsLocale; limit?: number; fetchImpl?: FetchLike },
): Promise<PayloadList<CmsCategory>> {
  return cmsRequest<PayloadList<CmsCategory>>(config, {
    path: "/api/categories",
    query: { locale: opts?.locale, limit: opts?.limit ?? 100, depth: 0 },
    fetchImpl: opts?.fetchImpl,
  });
}

export function fetchProducts(
  config: CmsConfig,
  opts?: { locale?: CmsLocale; limit?: number; page?: number; fetchImpl?: FetchLike },
): Promise<PayloadList<CmsProduct>> {
  return cmsRequest<PayloadList<CmsProduct>>(config, {
    path: "/api/products",
    query: { locale: opts?.locale, limit: opts?.limit ?? 100, page: opts?.page, depth: 0 },
    fetchImpl: opts?.fetchImpl,
  });
}

export function fetchStore(config: CmsConfig, opts?: { fetchImpl?: FetchLike }): Promise<PayloadList<CmsStore>> {
  return cmsRequest<PayloadList<CmsStore>>(config, { path: "/api/store", fetchImpl: opts?.fetchImpl });
}

export function fetchOrders(
  config: CmsConfig,
  opts?: { limit?: number; page?: number; status?: CmsOrder["status"]; fetchImpl?: FetchLike },
): Promise<PayloadList<CmsOrder>> {
  return cmsRequest<PayloadList<CmsOrder>>(config, {
    path: "/api/orders",
    query: {
      limit: opts?.limit ?? 50,
      page: opts?.page,
      depth: 0,
      ...(opts?.status ? { "where[status][equals]": opts.status } : {}),
    },
    fetchImpl: opts?.fetchImpl,
  });
}

/* ------------------------------------------------------------------ */
/* Site-level writes — requires the site's API key                      */
/* ------------------------------------------------------------------ */

export function createProduct(
  config: CmsConfig,
  input: {
    title: string;
    price: number;
    summary?: string;
    image?: string;
    sku?: string;
    trackInventory?: boolean;
    inventory?: number;
    compareAtPrice?: number;
  },
  opts?: { fetchImpl?: FetchLike },
): Promise<CmsProduct> {
  return cmsRequest<CmsProduct>(config, {
    method: "POST",
    path: "/api/products",
    body: input,
    fetchImpl: opts?.fetchImpl,
  });
}

export function updateProduct(
  config: CmsConfig,
  id: string,
  patch: Partial<{
    title: string;
    price: number;
    summary: string;
    image: string;
    sku: string;
    trackInventory: boolean;
    inventory: number;
    compareAtPrice: number;
  }>,
  opts?: { fetchImpl?: FetchLike },
): Promise<CmsProduct> {
  return cmsRequest<CmsProduct>(config, {
    method: "PATCH",
    path: `/api/products/${id}`,
    body: patch,
    fetchImpl: opts?.fetchImpl,
  });
}

export function deleteProduct(config: CmsConfig, id: string, opts?: { fetchImpl?: FetchLike }): Promise<null> {
  return cmsRequest<null>(config, { method: "DELETE", path: `/api/products/${id}`, fetchImpl: opts?.fetchImpl });
}

/** Order status transitions are the one write the site key makes on orders. */
export function updateOrderStatus(
  config: CmsConfig,
  id: string,
  status: CmsOrder["status"],
  opts?: { fetchImpl?: FetchLike },
): Promise<CmsOrder> {
  return cmsRequest<CmsOrder>(config, {
    method: "PATCH",
    path: `/api/orders/${id}`,
    body: { status },
    fetchImpl: opts?.fetchImpl,
  });
}

/* ------------------------------------------------------------------ */
/* Platform-level — requires the `role: "platform"` API key             */
/* ------------------------------------------------------------------ */

export function fetchSites(
  config: CmsConfig,
  opts?: { status?: CmsSite["status"]; limit?: number; fetchImpl?: FetchLike },
): Promise<PayloadList<CmsSite>> {
  return cmsRequest<PayloadList<CmsSite>>(config, {
    path: "/api/sites",
    query: { limit: opts?.limit ?? 100, depth: 0, ...(opts?.status ? { "where[status][equals]": opts.status } : {}) },
    fetchImpl: opts?.fetchImpl,
  });
}

/** `POST /api/provision-site` — creates a site, seeds starter content, invites the owner. */
export function provisionSite(
  config: CmsConfig,
  input: ProvisionSiteInput,
  opts?: { fetchImpl?: FetchLike },
): Promise<ProvisionSiteResult> {
  return cmsRequest<ProvisionSiteResult>(config, {
    method: "POST",
    path: "/api/provision-site",
    body: input,
    fetchImpl: opts?.fetchImpl,
  });
}

/** `POST /api/api-keys/issue` — issue a key; the raw key comes back exactly once. */
export function issueSiteApiKey(
  config: CmsConfig,
  input: { siteId?: string; name: string; role: "site" | "platform" },
  opts?: { fetchImpl?: FetchLike },
): Promise<IssuedApiKey> {
  return cmsRequest<IssuedApiKey>(config, {
    method: "POST",
    path: "/api/api-keys/issue",
    body: input,
    fetchImpl: opts?.fetchImpl,
  });
}

/** `GET /api/api-keys/list` — masked key summaries (never the raw key). */
export function listSiteApiKeys(
  config: CmsConfig,
  opts?: { siteId?: string; fetchImpl?: FetchLike },
): Promise<{ docs: ApiKeySummary[] }> {
  return cmsRequest<{ docs: ApiKeySummary[] }>(config, {
    path: "/api/api-keys/list",
    query: opts?.siteId ? { siteId: opts.siteId } : {},
    fetchImpl: opts?.fetchImpl,
  });
}

/** `POST /api/api-keys/revoke` — disables a key (row kept for audit). */
export function revokeSiteApiKey(config: CmsConfig, id: string, opts?: { fetchImpl?: FetchLike }): Promise<{ ok: boolean }> {
  return cmsRequest<{ ok: boolean }>(config, {
    method: "POST",
    path: "/api/api-keys/revoke",
    body: { id },
    fetchImpl: opts?.fetchImpl,
  });
}

/* ------------------------------------------------------------------ */
/* Media                                                               */
/* ------------------------------------------------------------------ */

/**
 * WAVE-9 §3.3: local uploads come back relative (`/api/media/file/…`) and
 * must resolve against the site's own origin, never the caller's. Do the
 * join here, in one place, so a move to R2 (absolute URLs) becomes a no-op.
 */
export function absoluteCmsMediaUrl(media: Pick<CmsMedia, "url"> | string | null | undefined, mediaOrigin: string): string | null {
  if (media === null || media === undefined) return null;
  const url = typeof media === "string" ? media : media.url;
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  return new URL(url, mediaOrigin).toString();
}
