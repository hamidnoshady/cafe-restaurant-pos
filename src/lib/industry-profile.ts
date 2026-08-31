/**
 * Phase 25 Wave 2 — what a business's industry actually changes about the app.
 *
 * Phase 21 gave each industry its own chart of accounts, item model, posting
 * rules, wizard path and dashboard page — but the *shell* stayed café-shaped.
 * `businesses.industry` only ever added: it revealed the three industry pages
 * and nothing else, while every F&B module (میزها، آشپزخانه، رزروها، منو، …)
 * was gated on feature flags that no industry turns off, and every label was a
 * literal in the component that rendered it. A jewellery shop got the whole
 * café app with a "طلا و جواهر" tab bolted on and a sidebar reading
 * «کافه و رستوران».
 *
 * This is the one place that answers "what does this industry get, and what is
 * it called". It is the industry-keyed counterpart of `features.ts` — a
 * disabled module is refused at the API guard, not merely hidden from the nav —
 * and the generalisation of the pattern `wizard-steps.ts` already used for the
 * setup wizard's steps.
 *
 * Framework-free (no `db`, no `next`) exactly like `industries.ts` and
 * `wizard-steps.ts`, so client components and Edge code can import it directly.
 * The DB-touching half — resolving a business's industry and enforcing the
 * module set — lives in `industry-guard.ts`.
 *
 * Note this is **not** an i18n layer and should not grow into one. It carries
 * only the handful of nouns that genuinely differ between trades; everything
 * else stays a literal where it is rendered.
 */
import type { Industry } from "./industries";

/**
 * A dashboard area a business either has or does not have.
 *
 * These are coarser than routes on purpose: one key covers a nav entry, its
 * page(s), its API prefix and any settings tab that belongs to it, so "does
 * this business have tables?" is asked and answered once.
 */
export const MODULE_KEYS = [
  "dashboard",
  "orders",
  "pos",
  "customers",
  "loyalty",
  "promotions",
  "commission",
  "tables",
  "waiter",
  "kitchen",
  "reservations",
  "delivery",
  "inventory",
  "menu",
  "jewelry",
  "watch",
  "accessories",
  "cosmetics",
  "wholesale",
  "tools_fittings",
  "haberdashery",
  "stock",
  "ledger",
  "integrations",
  "reports",
  "ai",
  "settings",
  // Phase 35 — module keys for the app ecosystem and the phases that build on
  // it. `workspace` is the ecosystem shell (gated by the `workspace` feature
  // flag, not a trade module) and is added to no industry's `modules`.
  // `crm` (Phase 36) and `website` (Phase 36b/reversal) are wired into
  // `CORE_MODULES` below; `messaging` is still the subject of a later phase
  // and stays unassigned until it wires up its own pages. They exist now so
  // the app registry (src/lib/apps.ts) can give them a place and so a later
  // phase need not touch the union again.
  "workspace",
  "crm",
  "website",
  "messaging",
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

/** The nouns that differ by trade. Anything not listed here is the same word everywhere. */
export type LabelKey =
  /** One sale, as a document: «سفارش» in a café, «فاکتور» in a shop. */
  | "saleDocument"
  /** Its plural, for the nav entry and list heading. */
  | "saleDocumentPlural"
  /** The screen you sell from. */
  | "sellScreen"
  /** The list of things you sell. */
  | "catalogue"
  /** One entry in that list. */
  | "catalogueItem";

export type SalesModel =
  /** F&B: an order is opened, sent to the kitchen, and settled — today's POS. */
  | "order_ticket"
  /** Retail: lines are priced onto an invoice and settled in one go (Wave 3). */
  | "retail_invoice";

/**
 * Phase 27 — a finer-grained switch than a ModuleKey: a capability lives
 * *inside* a trade's own module (or inside the POS it already has), so it has
 * no page or API prefix of its own and no nav entry to hide. Read by the UI
 * and by the trade's service layer; the routes are already gated by
 * `requireIndustryForApi`, which is the stricter check, so a capability is
 * never a third guard axis.
 */
export const CAPABILITY_KEYS = ["batch_expiry", "barcode", "repairs"] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export interface IndustryProfile {
  /** Sidebar brand block, in place of the hardcoded «کافه و رستوران». */
  brandTitle: string;
  brandSubtitle: string;
  modules: readonly ModuleKey[];
  /** Only the keys that differ from `FALLBACK_LABELS`; the rest fall through. */
  labels: Partial<Record<LabelKey, string>>;
  salesModel: SalesModel;
  /**
   * Feature flags to seed as "off" overrides at provision time, for capability
   * this industry has no use for. Seeded through the same loop
   * `LOCAL_DISABLED_FEATURES` already uses (business-provisioning.ts), and
   * stays individually flippable from the platform console afterwards — an
   * industry default, not a prohibition.
   */
  defaultDisabledFeatures: readonly string[];
  /**
   * Phase 27 — capabilities this trade has, switched on from this one place
   * rather than from an `if (industry === …)` in the app. See CAPABILITY_KEYS.
   */
  capabilities: readonly CapabilityKey[];
}

/** F&B's wording is the base: every other industry overrides only what it must. */
const FALLBACK_LABELS: Record<LabelKey, string> = {
  saleDocument: "سفارش",
  saleDocumentPlural: "سفارش‌ها",
  sellScreen: "صندوق (فروش)",
  catalogue: "منو",
  catalogueItem: "آیتم منو",
};

const RETAIL_LABELS: Partial<Record<LabelKey, string>> = {
  saleDocument: "فاکتور",
  saleDocumentPlural: "فاکتورها",
  sellScreen: "فروش و فاکتور",
  catalogue: "کالاها",
  catalogueItem: "کالا",
};

/**
 * The F&B-only modules. Named rather than inlined three times so that adding a
 * fifth industry is one line, and so the list reads as the answer to "what
 * makes a café a café": table service, a kitchen to send tickets to, bookings,
 * couriers, a recipe-costed raw-material store, and a menu.
 */
const FOOD_SERVICE_MODULES: readonly ModuleKey[] = [
  "tables",
  "waiter",
  "kitchen",
  "reservations",
  "delivery",
  "inventory",
  "menu",
];

/** What every business has regardless of trade — the core accounting/admin platform. */
const CORE_MODULES: readonly ModuleKey[] = [
  "dashboard",
  "customers",
  // Phase 36 — the CRM ships to every trade, for the same reason `customers`
  // does: a jeweller keeps a customer file exactly as a café does, and the
  // whole app is built on records (`customers`, `orders`, `payments`) every
  // profile already has. Phase 35 declared this key without assigning it,
  // because its pages did not exist yet; they do now.
  "crm",
  "loyalty",
  "promotions",
  "commission",
  // Website manager (#378) ships to every trade too: a jeweller wants a
  // storefront exactly as a café wants a menu site, and the module gates the
  // one CMS connection this app holds rather than a trade-specific screen —
  // see the "website" app in src/lib/apps.ts and docs/eshobe-cms-integration.md.
  "website",
  "ledger",
  "integrations",
  "reports",
  "ai",
  "settings",
];

/**
 * Selling modules.
 *
 * Both industries sell from `/dashboard/pos` — the route branches on
 * `salesModel` — so every profile has "pos".
 *
 * "orders" is F&B-only, and not as an oversight: `/dashboard/orders` is a live
 * board of *open* order tickets, with kitchen statuses, table filters and a
 * realtime feed. A retail invoice is settled the moment it is written, so it
 * would never appear there. The shop's sales history lives on its own selling
 * screen instead, which is also where a counter actually looks for it.
 */
const SELLING_MODULES: readonly ModuleKey[] = ["orders", "pos"];

/**
 * Phase 27 Wave 8 — purchasing/returns/transfers on the `items` model and the
 * reorder/low-stock reports. Retail-only: F&B's equivalent is `inventory`.
 */
const RETAIL_STOCK_MODULES: readonly ModuleKey[] = ["stock"];

export const INDUSTRY_PROFILES: Record<Industry, IndustryProfile> = {
  food_service: {
    brandTitle: "کافه و رستوران",
    brandSubtitle: "مدیریت عملیات روزانه",
    modules: [...CORE_MODULES, ...SELLING_MODULES, ...FOOD_SERVICE_MODULES],
    labels: {},
    salesModel: "order_ticket",
    defaultDisabledFeatures: [],
    capabilities: [],
  },
  jewelry: {
    brandTitle: "طلا و جواهر",
    brandSubtitle: "مدیریت خرید، فروش و موجودی",
    modules: [...CORE_MODULES, "pos", "jewelry", ...RETAIL_STOCK_MODULES],
    labels: RETAIL_LABELS,
    salesModel: "retail_invoice",
    // `inventory` is F&B's recipe-costed raw-material store
    // (`inventory_items`/`stock_movements`); jewellery stock lives in Phase
    // 21's `items`/`item_weight_attributes` and is managed from its own page.
    // `reservations` gates tables and the floor plan, which have no meaning in
    // a shop.
    defaultDisabledFeatures: ["inventory", "reservations", "delivery"],
    // `repairs` (Wave 10): repair_tickets is already generic (item_description,
    // nullable serial_id), so a jeweller uses the same workflow a watch shop does.
    capabilities: ["barcode", "repairs"],
  },
  watch: {
    brandTitle: "ساعت",
    brandSubtitle: "مدیریت فروش، گارانتی و تعمیرات",
    modules: [...CORE_MODULES, "pos", "watch", ...RETAIL_STOCK_MODULES],
    labels: RETAIL_LABELS,
    salesModel: "retail_invoice",
    defaultDisabledFeatures: ["inventory", "reservations", "delivery"],
    capabilities: ["barcode", "repairs"],
  },
  accessories: {
    brandTitle: "بدلیجات",
    brandSubtitle: "مدیریت تنوع‌ها، موجودی و فروش",
    modules: [...CORE_MODULES, "pos", "accessories", ...RETAIL_STOCK_MODULES],
    labels: RETAIL_LABELS,
    salesModel: "retail_invoice",
    defaultDisabledFeatures: ["inventory", "reservations", "delivery"],
    capabilities: ["barcode"],
  },
  cosmetics: {
    brandTitle: "آرایشی و بهداشتی",
    brandSubtitle: "مدیریت برند، بچ و تاریخ انقضا",
    modules: [...CORE_MODULES, "pos", "cosmetics", ...RETAIL_STOCK_MODULES],
    labels: RETAIL_LABELS,
    salesModel: "retail_invoice",
    defaultDisabledFeatures: ["inventory", "reservations", "delivery"],
    capabilities: ["batch_expiry", "barcode"],
  },
  wholesale: {
    brandTitle: "عمده‌فروشی",
    brandSubtitle: "مدیریت خرید عمده، موجودی و فروش",
    modules: [...CORE_MODULES, "pos", "wholesale", ...RETAIL_STOCK_MODULES],
    labels: RETAIL_LABELS,
    salesModel: "retail_invoice",
    // Same F&B-only modules off as the other retail trades; a wholesale
    // business also has no tables, kitchen, reservations or delivery flow.
    defaultDisabledFeatures: ["inventory", "reservations", "delivery"],
    capabilities: ["barcode"],
  },
  tools_fittings: {
    brandTitle: "ابزار و یراق‌آلات",
    brandSubtitle: "مدیریت کالا، موجودی و فروش ابزار و یراق",
    modules: [...CORE_MODULES, "pos", "tools_fittings", ...RETAIL_STOCK_MODULES],
    labels: RETAIL_LABELS,
    salesModel: "retail_invoice",
    defaultDisabledFeatures: ["inventory", "reservations", "delivery"],
    capabilities: ["barcode"],
  },
  haberdashery: {
    brandTitle: "خرازی",
    brandSubtitle: "مدیریت لوازم خیاطی، موجودی و فروش",
    modules: [...CORE_MODULES, "pos", "haberdashery", ...RETAIL_STOCK_MODULES],
    labels: RETAIL_LABELS,
    salesModel: "retail_invoice",
    defaultDisabledFeatures: ["inventory", "reservations", "delivery"],
    capabilities: ["barcode"],
  },
};

export function industryProfile(industry: Industry): IndustryProfile {
  return INDUSTRY_PROFILES[industry];
}

/** Whether this industry has a module at all — the question nav, pages and API guards all ask. */
export function hasModule(industry: Industry, module: ModuleKey): boolean {
  return INDUSTRY_PROFILES[industry].modules.includes(module);
}

/** Whether this trade has a Phase 27 capability switched on (batch expiry, barcode, repairs, …). */
export function hasCapability(industry: Industry, capability: CapabilityKey): boolean {
  return INDUSTRY_PROFILES[industry].capabilities.includes(capability);
}

/** This industry's word for something, falling back to F&B's when it has no opinion. */
export function labelFor(industry: Industry, key: LabelKey): string {
  return INDUSTRY_PROFILES[industry].labels[key] ?? FALLBACK_LABELS[key];
}

/**
 * Dashboard page prefix → the module that owns it, for each gated page's own
 * redirect. Deliberately the same shape as `features.ts`'s
 * `PAGE_FEATURE_PREFIXES`, so the two guards read alike at their call sites.
 */
export const PAGE_MODULE_PREFIXES: readonly (readonly [string, ModuleKey])[] = [
  ["/dashboard/orders", "orders"],
  ["/dashboard/pos", "pos"],
  ["/dashboard/floor", "tables"],
  ["/dashboard/waiter", "waiter"],
  ["/dashboard/kitchen", "kitchen"],
  ["/dashboard/reservations", "reservations"],
  ["/dashboard/delivery", "delivery"],
  ["/dashboard/inventory", "inventory"],
  ["/dashboard/menu", "menu"],
  ["/dashboard/jewelry", "jewelry"],
  ["/dashboard/watch", "watch"],
  ["/dashboard/accessories", "accessories"],
  ["/dashboard/cosmetics", "cosmetics"],
  ["/dashboard/wholesale", "wholesale"],
  ["/dashboard/tools-fittings", "tools_fittings"],
  ["/dashboard/haberdashery", "haberdashery"],
  ["/dashboard/loyalty", "loyalty"],
  ["/dashboard/promotions", "promotions"],
  ["/dashboard/commission", "commission"],
  // Phase 36b — the Growth & Marketing app's home. Anchored on `loyalty`
  // (core for every trade) like its nav entry: the app is the container for
  // loyalty, promotions and commission, and a business that had any of the
  // three has loyalty.
  ["/dashboard/growth", "loyalty"],
  // Phase 36 — the CRM app's home. Anchored on `customers` (core for every
  // trade, exactly like the flat «مشتریان» page it absorbs) rather than on the
  // `crm` module key: a business that has customers has a CRM, and gating the
  // app on a module no industry profile lists yet would hide it from everyone.
  ["/dashboard/crm", "customers"],
  // The website manager's own app (issue #378) — pulled out of Growth &
  // Marketing to be a peer of it, not a section inside it (src/lib/apps.ts).
  ["/dashboard/website", "website"],
  ["/dashboard/stock", "stock"],
];

/**
 * API route prefix → the module that owns it.
 *
 * Same role as `featureForApiPath`: without it, hiding a nav entry would be
 * decoration — the routes would still answer. Prefixes not listed here belong
 * to every industry (auth, settings, locations, customers, ledger, reports, …)
 * or are already industry-gated by `requireIndustryForApi` at the handler
 * (`/api/jewelry/*`, `/api/watch/*`, `/api/accessories/*`), which is a stricter
 * check than this one and stays as it is.
 */
const API_MODULE_PREFIXES: readonly (readonly [string, ModuleKey])[] = [
  ["/api/orders", "orders"],
  ["/api/menu", "menu"],
  ["/api/tables", "tables"],
  ["/api/table-sessions", "tables"],
  ["/api/floor", "tables"],
  ["/api/reservations", "reservations"],
  ["/api/kitchen", "kitchen"],
  ["/api/deliveries", "delivery"],
  ["/api/couriers", "delivery"],
  ["/api/inventory", "inventory"],
  ["/api/loyalty", "loyalty"],
  ["/api/promotions", "promotions"],
  ["/api/commission", "commission"],
  // Phase 36 — the CRM app's routes. The customer *directory* (`/api/customers`)
  // stays ungated: every trade has customers, and the POS's credit-payment
  // picker calls it. What the `crm` module gates is the CRM's own surfaces —
  // segments, the pipeline, cases, consent history.
  ["/api/crm", "crm"],
  // Only the website manager's own screen — `/api/cms/revalidate` is the
  // CMS's inbound publish webhook (HMAC-verified, no session, no
  // `withTenantScope`) and must stay outside this list.
  ["/api/cms/website", "website"],
  ["/api/stock", "stock"],
];

export function moduleForApiPath(pathname: string): ModuleKey | null {
  for (const [prefix, module] of API_MODULE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return module;
  }
  return null;
}

export function moduleForPagePath(pathname: string): ModuleKey | null {
  for (const [prefix, module] of PAGE_MODULE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return module;
  }
  return null;
}
