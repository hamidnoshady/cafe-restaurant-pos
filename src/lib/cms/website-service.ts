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
import {
  CmsApiError,
  CmsNetworkError,
  fetchOrders,
  fetchPages,
  fetchProducts,
  fetchSiteDescriptor,
  issueSiteApiKey,
  provisionSite,
  updateOrderStatus,
  type CmsConfig,
} from "./client";
import type { CmsOrder, CmsPage, CmsProduct, SiteDescriptor } from "./types";
import { cmsPlatformConfig } from "./config";
import {
  CmsConnectionError,
  deleteCmsConnection,
  getCmsConfigForBusiness,
  listCmsConnections,
  saveCmsConnection,
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
    const [site, pages, products, orders] = await Promise.all([
      fetchSiteDescriptor(config),
      fetchPages(config, { limit: 20 }),
      fetchProducts(config, { limit: 50 }),
      fetchOrders(config, { limit: 50 }),
    ]);
    return { ok: true, data: { site, pages: pages.docs, products: products.docs, orders: orders.docs } };
  } catch (error) {
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    if (error instanceof CmsApiError && error.status === 404) return { ok: false, error: "not_connected" };
    return { ok: false, error: "cms_error" };
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
