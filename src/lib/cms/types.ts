/**
 * Eshobe CMS — the contract types this app consumes over REST.
 *
 * These mirror the shapes Payload returns for the collections the site
 * builder needs (`payload-types.ts` in the eshobe-cms repo). They are
 * deliberately curated rather than generated: this app does not ship
 * `payload`, and the fields below are the ones the builder (POS/SaaS
 * platform) actually reads or writes. Relationships are shallow (`string`)
 * by default — pull the related document with `depth` when you need it, and
 * widen the type at the call site.
 *
 * Tenant rule (WAVE-9 §1 of eshobe-cms): the tenant is resolved server-side
 * from the site's `Host` header / API key. A `where[site][equals]=…` filter
 * can narrow a result but is never how we *choose* a tenant.
 */

/** Payload list envelope (`GET /api/{collection}`). */
export interface PayloadList<T> {
  docs: T[];
  totalDocs: number;
  limit: number;
  totalPages: number;
  page: number;
  pagingCounter: number;
  hasPrevPage: boolean;
  hasNextPage: boolean;
  prevPage: number | null;
  nextPage: number | null;
}

export type CmsLocale = "fa" | "en";

/** `GET /api/site` — the descriptor a renderer needs before first paint. */
export interface SiteDescriptor {
  availableLocales: CmsLocale[];
  blocks: string[];
  defaultLocale: CmsLocale;
  domain: string;
  media: { basePath: string; origin: string };
  name: string;
  slug: string;
  status: "active" | "suspended" | "archived";
  store: { currency: "EUR" | "IRR" | "IRT" | "USD"; paymentProvider: "bank" | "http" };
  theme: SiteTheme | null;
  type: "business" | "portfolio" | "store";
}

export interface SiteTheme {
  primary?: string | null;
  accent?: string | null;
  background?: string | null;
  foreground?: string | null;
  radius?: "none" | "sm" | "md" | "lg" | null;
  lineHeight?: number | null;
}

/** The `sites` collection. */
export interface CmsSite {
  id: string;
  name: string;
  domain: string;
  domainVerified?: boolean | null;
  type: "business" | "portfolio" | "store";
  status: "active" | "suspended" | "archived";
  availableLocales: CmsLocale[];
  defaultLocale: CmsLocale;
  slug: string;
  updatedAt: string;
  createdAt: string;
}

/** Lexical rich-text root (Payload serialized). */
export interface LexicalRoot {
  root: {
    type: string;
    children: unknown[];
    direction: "ltr" | "rtl" | null;
    format: string;
    indent: number;
    version: number;
  };
  [key: string]: unknown;
}

export interface CmsMedia {
  id: string;
  alt?: string | null;
  url?: string | null;
  thumbnailURL?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  filesize?: number | null;
  width?: number | null;
  height?: number | null;
  sizes?: Record<
    string,
    { url?: string | null; width?: number | null; height?: number | null; mimeType?: string | null; filename?: string | null } | undefined
  >;
}

export interface CmsPage {
  id: string;
  title: string;
  slug: string;
  layout: unknown[];
  publishedAt?: string | null;
  updatedAt: string;
  createdAt: string;
  _status?: "draft" | "published" | null;
}

export interface CmsPost {
  id: string;
  title: string;
  slug: string;
  content: LexicalRoot;
  heroImage?: string | CmsMedia | null;
  categories?: (string | CmsCategory)[] | null;
  publishedAt?: string | null;
  updatedAt: string;
  createdAt: string;
  _status?: "draft" | "published" | null;
}

export interface CmsCategory {
  id: string;
  title: string;
  slug: string;
  parent?: string | CmsCategory | null;
  updatedAt: string;
  createdAt: string;
}

export interface CmsProduct {
  id: string;
  title: string;
  summary?: string | null;
  image?: string | CmsMedia | null;
  /** Integer in the site's minor currency unit (Toman/Rial — never convert client-side). */
  price: number;
  compareAtPrice?: number | null;
  sku?: string | null;
  trackInventory?: boolean | null;
  inventory?: number | null;
  updatedAt: string;
  createdAt: string;
  _status?: "draft" | "published" | null;
}

export interface CmsOrder {
  id: string;
  reference: string;
  status: "pending" | "paid" | "cancelled" | "refunded";
  product: string | CmsProduct;
  productTitle?: string | null;
  quantity: number;
  /** Snapshot at purchase time — not the product's current price. */
  unitPrice: number;
  total: number;
  currency: "EUR" | "IRR" | "IRT" | "USD";
  buyer: { name: string; phone: string; email?: string | null; note?: string | null };
  updatedAt: string;
  createdAt: string;
}

export interface CmsStore {
  currency: "EUR" | "IRR" | "IRT" | "USD";
  paymentProvider: "bank" | "http";
  paymentInstructions?: string | null;
}

/** Response of `POST /api/site-api-keys` — the key is shown exactly once. */
export interface IssuedApiKey {
  id: string;
  name: string;
  role: "site" | "platform";
  /** `eshobe_live_…` — only present on creation, never again. */
  key: string;
  prefix: string;
}

/** An API-key row as listed (masked — never contains the raw key). */
export interface ApiKeySummary {
  id: string;
  name: string;
  role: "site" | "platform";
  prefix: string;
  lastUsedAt: string | null;
  siteId: string | null;
  createdAt: string;
}

export interface ProvisionSiteInput {
  name: string;
  domain: string;
  type: "business" | "portfolio" | "store";
  locales?: CmsLocale[];
  defaultLocale?: CmsLocale;
  adminEmail?: string;
  adminName?: string;
}

export interface ProvisionSiteResult {
  site: {
    adminUrl: string;
    availableLocales: CmsLocale[];
    defaultLocale: CmsLocale;
    domain: string;
    id: string;
    name: string;
    type: "business" | "portfolio" | "store";
    url: string;
  };
  summary: { forms: number; footers: number; headers: number; pages: number; themes: number; users: number };
  users: { email: string; id: string; name: string }[];
}
