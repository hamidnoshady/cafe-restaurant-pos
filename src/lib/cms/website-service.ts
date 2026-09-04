/**
 * Eshobe CMS — the Website Manager service (issue #378's subject, built on
 * the headless integration).
 *
 * The screen-level orchestration: connect a business to its CMS site (test
 * first, then store the key encrypted), or provision a brand-new site from
 * the operator's platform key; then read the site's descriptor, pages,
 * products and orders, and move order statuses.
 *
 * All validation returns an error *code* the API layer maps to a status and
 * the UI maps to Persian (see src/app/dashboard/ui.tsx) — the same contract
 * `connections-service.ts` uses. DB-touching, per repo convention not unit
 * tested directly; the client it leans on is (client.test.ts).
 */
import { promises as dns } from "node:dns";
import {
  CmsApiError,
  CmsNetworkError,
  createPost,
  createProduct,
  deletePost,
  deleteProduct,
  fetchOrders,
  fetchPages,
  fetchPosts,
  fetchProducts,
  fetchSiteDescriptor,
  issueSiteApiKey,
  provisionSite,
  updateOrderStatus,
  updatePost,
  updateProduct,
  updateSiteDomain as updateSiteDomainOnCms,
  type CmsConfig,
} from "./client";
import { simpleLexicalRoot, type CmsOrder, type CmsPage, type CmsPost, type CmsProduct, type SiteDescriptor } from "./types";
import { cmsPlatformConfig } from "./config";
import { dnsHint, ipsOverlap, type DnsCheck } from "./dns";
import {
  CmsConnectionError,
  deleteCmsConnection,
  getCmsConfigForBusiness,
  listCmsConnections,
  saveCmsConnection,
  updateCmsConnectionDomain,
  type CmsConnectionSummary,
} from "./connections";

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const SITE_TYPES = ["business", "portfolio", "store"] as const;

export interface WebsiteConnectInput {
  baseUrl: string;
  siteDomain: string;
  apiKey: string;
  keyName?: string;
}

export interface WebsiteProvisionInput {
  name: string;
  domain: string;
  type: (typeof SITE_TYPES)[number];
}

export type WebsiteResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Masked connection state — safe for the browser. */
export async function cmsWebsiteState(businessId: string): Promise<CmsConnectionSummary | null> {
  const rows = await listCmsConnections(businessId);
  return rows[0] ?? null;
}

/**
 * Connect an *existing* CMS site: probe it with the credentials first
 * (descriptor answers one call: does the key work, which site is it), then
 * store the key encrypted. `SiteDescriptor.id` came with the CMS's
 * `/api/site` (patch §5) — it is what revalidation tags key on.
 */
export async function connectCmsWebsite(
  businessId: string,
  input: WebsiteConnectInput,
): Promise<WebsiteResult<{ site: SiteDescriptor; connection: CmsConnectionSummary }>> {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) return { ok: false, error: "invalid_cms_base_url" };

  const domain = input.siteDomain.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(domain)) return { ok: false, error: "invalid_domain" };

  const apiKey = input.apiKey.trim();
  if (!apiKey.startsWith("eshobe_live_")) return { ok: false, error: "invalid_api_key" };

  const probe: CmsConfig = { baseUrl, siteDomain: domain, apiKey };
  let site: SiteDescriptor;
  try {
    site = await fetchSiteDescriptor(probe);
  } catch (error) {
    if (error instanceof CmsApiError) return { ok: false, error: "connection_failed" };
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    return { ok: false, error: "connection_failed" };
  }
  if (!site.id) return { ok: false, error: "cms_old_version" };

  // The probe resolved the tenant; the descriptor's own domain is the answer
  // that must win — a key pasted for the wrong domain is a config error, not
  // a silent cross-tenant connect.
  if (site.domain !== domain) return { ok: false, error: "domain_mismatch" };

  await saveCmsConnection({
    businessId,
    siteId: site.id,
    siteDomain: domain,
    baseUrl,
    apiKey,
    keyName: input.keyName?.trim() || `پنل مدیریت (${domain})`,
  });

  return { ok: true, data: { site, connection: (await cmsWebsiteState(businessId))! } };
}

/**
 * Provision a new site from the operator's platform key: the CMS creates the
 * site + starter content (Wave 5), we issue its site key in the same breath
 * and store it — the business is connected before the UI ever returns.
 */
export async function provisionCmsWebsite(
  businessId: string,
  input: WebsiteProvisionInput,
): Promise<WebsiteResult<{ site: Provisioned; connection: CmsConnectionSummary }>> {
  const platform = cmsPlatformConfig(process.env);
  if (!platform) return { ok: false, error: "cms_not_configured" };

  const name = input.name.trim();
  if (!name || name.length > 120) return { ok: false, error: "invalid_name" };
  const domain = input.domain.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(domain)) return { ok: false, error: "invalid_domain" };
  if (!SITE_TYPES.includes(input.type)) return { ok: false, error: "invalid_type" };

  let site;
  try {
    site = await provisionSite(platform, { name, domain, type: input.type });
  } catch (error) {
    if (error instanceof CmsApiError) return { ok: false, error: "provision_failed" };
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    return { ok: false, error: "provision_failed" };
  }

  let key;
  try {
    key = await issueSiteApiKey(platform, {
      siteId: site.site.id,
      name: `اتصال پنل مدیریت (${domain})`,
      role: "site",
    });
  } catch (error) {
    return { ok: false, error: error instanceof CmsNetworkError ? "cms_unreachable" : "key_issue_failed" };
  }

  await saveCmsConnection({
    businessId,
    siteId: site.site.id,
    siteDomain: site.site.domain,
    baseUrl: platform.baseUrl,
    apiKey: key.key,
    keyName: `اتصال پنل مدیریت (${domain})`,
  });

  return { ok: true, data: { site, connection: (await cmsWebsiteState(businessId))! } };
}

export async function disconnectCmsWebsite(businessId: string): Promise<void> {
  await deleteCmsConnection(businessId);
}

export interface WebsiteOverview {
  site: SiteDescriptor;
  pages: CmsPage[];
  posts: CmsPost[];
  products: CmsProduct[];
  orders: CmsOrder[];
}

/** The connected site, in one call. Every read is cached by the CMS itself. */
export async function cmsWebsiteOverview(businessId: string): Promise<WebsiteResult<WebsiteOverview>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch (error) {
    return { ok: false, error: error instanceof CmsConnectionError ? "not_connected" : "cms_config_error" };
  }

  try {
    const [site, pages, posts, products, orders] = await Promise.all([
      fetchSiteDescriptor(config),
      fetchPages(config, { limit: 20 }),
      fetchPosts(config, { limit: 20 }),
      fetchProducts(config, { limit: 50 }),
      fetchOrders(config, { limit: 50 }),
    ]);
    return {
      ok: true,
      data: { site, pages: pages.docs, posts: posts.docs, products: products.docs, orders: orders.docs },
    };
  } catch (error) {
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    if (error instanceof CmsApiError && error.status === 404) return { ok: false, error: "not_connected" };
    return { ok: false, error: "cms_error" };
  }
}

/** Shared 4xx/5xx → `WebsiteResult` error-code mapping for the CRUD writes below. */
function mapCmsWriteError(error: unknown): WebsiteResult<never> {
  if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
  if (error instanceof CmsApiError) {
    if (error.status === 404) return { ok: false, error: "not_found" };
    if (error.status === 403) return { ok: false, error: "forbidden" };
    if (error.status === 409) return { ok: false, error: "domain_taken" };
  }
  return { ok: false, error: "cms_error" };
}

export interface CmsPostInput {
  title: string;
  content: string;
  heroImage?: string;
  categories?: string[];
}

function validatePostInput(
  input: Partial<CmsPostInput>,
  opts: { requireAll: boolean },
): { ok: false; error: string } | null {
  if ((opts.requireAll || input.title !== undefined) && !input.title?.trim()) {
    return { ok: false, error: "title_required" };
  }
  if (input.title !== undefined && input.title.trim().length > 200) return { ok: false, error: "field_too_long" };
  if ((opts.requireAll || input.content !== undefined) && !input.content?.trim()) {
    return { ok: false, error: "content_required" };
  }
  return null;
}

export async function createCmsPost(businessId: string, input: CmsPostInput): Promise<WebsiteResult<CmsPost>> {
  const invalid = validatePostInput(input, { requireAll: true });
  if (invalid) return invalid;

  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    const post = await createPost(config, {
      title: input.title.trim(),
      content: simpleLexicalRoot(input.content),
      heroImage: input.heroImage,
      categories: input.categories,
    });
    return { ok: true, data: post };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export async function updateCmsPost(
  businessId: string,
  id: string,
  input: Partial<CmsPostInput>,
): Promise<WebsiteResult<CmsPost>> {
  const invalid = validatePostInput(input, { requireAll: false });
  if (invalid) return invalid;

  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    const post = await updatePost(config, id, {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.content !== undefined ? { content: simpleLexicalRoot(input.content) } : {}),
      ...(input.heroImage !== undefined ? { heroImage: input.heroImage } : {}),
      ...(input.categories !== undefined ? { categories: input.categories } : {}),
    });
    return { ok: true, data: post };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export async function deleteCmsPost(businessId: string, id: string): Promise<WebsiteResult<null>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    await deletePost(config, id);
    return { ok: true, data: null };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export interface CmsProductInput {
  title: string;
  price: number;
  summary?: string;
  image?: string;
  sku?: string;
  trackInventory?: boolean;
  inventory?: number;
  compareAtPrice?: number;
}

function validateProductInput(
  input: Partial<CmsProductInput>,
  opts: { requireAll: boolean },
): { ok: false; error: string } | null {
  if ((opts.requireAll || input.title !== undefined) && !input.title?.trim()) {
    return { ok: false, error: "title_required" };
  }
  if (input.title !== undefined && input.title.trim().length > 200) return { ok: false, error: "field_too_long" };
  if (opts.requireAll || input.price !== undefined) {
    if (!Number.isInteger(input.price) || (input.price as number) < 0) return { ok: false, error: "invalid_price" };
  }
  if (input.compareAtPrice !== undefined && (!Number.isInteger(input.compareAtPrice) || input.compareAtPrice < 0)) {
    return { ok: false, error: "invalid_price" };
  }
  if (input.inventory !== undefined && (!Number.isInteger(input.inventory) || input.inventory < 0)) {
    return { ok: false, error: "invalid_inventory" };
  }
  return null;
}

export async function createCmsProduct(businessId: string, input: CmsProductInput): Promise<WebsiteResult<CmsProduct>> {
  const invalid = validateProductInput(input, { requireAll: true });
  if (invalid) return invalid;

  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    const product = await createProduct(config, { ...input, title: input.title.trim() });
    return { ok: true, data: product };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export async function updateCmsProduct(
  businessId: string,
  id: string,
  input: Partial<CmsProductInput>,
): Promise<WebsiteResult<CmsProduct>> {
  const invalid = validateProductInput(input, { requireAll: false });
  if (invalid) return invalid;

  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    const product = await updateProduct(config, id, {
      ...input,
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    });
    return { ok: true, data: product };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export async function deleteCmsProduct(businessId: string, id: string): Promise<WebsiteResult<null>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    await deleteProduct(config, id);
    return { ok: true, data: null };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

/**
 * Moves the connected site to a new domain: validate the format, call the
 * CMS (which resets `domainVerified` server-side), then keep the stored
 * connection's `site_domain` in step — every later call forwards it as
 * `Host`, and the DNS checklist's preview URL is built from it.
 */
export async function updateCmsSiteDomain(
  businessId: string,
  domain: string,
): Promise<WebsiteResult<{ domain: string; domainVerified: boolean }>> {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(normalized)) return { ok: false, error: "invalid_domain" };

  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    const result = await updateSiteDomainOnCms(config, normalized);
    await updateCmsConnectionDomain(businessId, result.domain);
    return { ok: true, data: result };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

const ORDER_STATUSES: CmsOrder["status"][] = ["pending", "paid", "cancelled", "refunded"];

export async function updateCmsOrderStatus(
  businessId: string,
  orderId: string,
  status: string,
): Promise<WebsiteResult<CmsOrder>> {
  if (!ORDER_STATUSES.includes(status as CmsOrder["status"])) {
    return { ok: false, error: "invalid_status" };
  }

  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    const order = await updateOrderStatus(config, orderId, status as CmsOrder["status"]);
    return { ok: true, data: order };
  } catch (error) {
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    if (error instanceof CmsApiError && error.status === 404) return { ok: false, error: "not_found" };
    if (error instanceof CmsApiError && error.status === 403) return { ok: false, error: "forbidden" };
    return { ok: false, error: "cms_error" };
  }
}

type Provisioned = Awaited<ReturnType<typeof provisionSite>>;

/* ------------------------------------------------------------------ */
/* DNS checklist + in-app preview                                      */
/* ------------------------------------------------------------------ */

const DNS_TIMEOUT_MS = 4_000;

/**
 * Resolve a host's A/AAAA addresses with a short timeout. An empty array is
 * "did not resolve" — never an exception: a missing record is the thing the
 * checklist exists to surface, not a crash.
 */
async function resolveAddresses(host: string): Promise<string[]> {
  const lookup = async (): Promise<string[]> => {
    const [a, aaaa] = await Promise.allSettled([
      dns.resolve4(host).catch(() => []),
      dns.resolve6(host).catch(() => []),
    ]);
    const v4 = a.status === "fulfilled" ? a.value : [];
    const v6 = aaaa.status === "fulfilled" ? aaaa.value : [];
    return [...v4, ...v6];
  };
  try {
    return await Promise.race([
      lookup(),
      new Promise<string[]>((resolve) => setTimeout(() => resolve([]), DNS_TIMEOUT_MS)),
    ]);
  } catch {
    return [];
  }
}

export interface CmsDnsStatus {
  dns: DnsCheck;
  /** The CMS's own confirmation (descriptor `domainVerified`), if readable. */
  domainVerified: boolean | null;
  /** `https://{domain}/` — what the live site (and the iframe) loads on. */
  previewUrl: string;
}

/**
 * The DNS checklist's two observable facts for the connected site: does the
 * domain resolve to the CMS server, and has the operator verified it in the
 * CMS admin. The server does the resolution (same resolver family browsers
 * use); the client only renders the result.
 */
export async function cmsWebsiteDns(businessId: string): Promise<WebsiteResult<CmsDnsStatus>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch (error) {
    return { ok: false, error: error instanceof CmsConnectionError ? "not_connected" : "cms_config_error" };
  }

  const siteDomain = config.siteDomain ?? "";
  const cmsHost = new URL(config.baseUrl).hostname;
  const [domainAddresses, cmsAddresses] = await Promise.all([
    resolveAddresses(siteDomain),
    resolveAddresses(cmsHost),
  ]);
  const dnsCheck: DnsCheck = {
    resolved: domainAddresses.length > 0,
    pointingToCms: ipsOverlap(domainAddresses, cmsAddresses),
    cmsHost,
    domainAddresses,
    cmsAddresses,
  };

  let domainVerified: boolean | null = null;
  try {
    const site = await fetchSiteDescriptor(config);
    domainVerified = Boolean(site.domainVerified);
  } catch {
    // The descriptor is not required for the DNS side of the answer.
    domainVerified = null;
  }

  return {
    ok: true,
    data: {
      dns: dnsCheck,
      domainVerified,
      previewUrl: `https://${siteDomain}/`,
    },
  };
}

// `cmsDnsHint` lives in ./dns (pure) so the dashboard's client component can
// render it without pulling this DB-backed module into the browser bundle.
export { cmsDnsHint } from "./dns";
