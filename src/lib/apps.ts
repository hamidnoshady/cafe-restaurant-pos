/**
 * Phase 35 Wave 1 — the app registry.
 *
 * The dashboard used to be one flat list of nav entries (see
 * src/app/dashboard/layout.tsx), each naming the `ModuleKey` that owns it. That
 * list is fine while every entry is a peer, but three of them — «وفاداری»,
 * «کمپین‌ها و کارت هدیه» and «پورسانت فروشندگان» — are really one idea
 * (keeping and growing customers), and the phases that follow this one (CRM,
 * messaging, the website manager) each want to add another peer to the same
 * flat list.
 *
 * This is the grouping they will share. It is deliberately *only* a grouping:
 * `ModuleKey` still answers "does this trade have this area"
 * (src/lib/industry-profile.ts) and `moduleForApiPath` is still the API guard.
 * An app is just a named bundle of modules, so "show the Growth & Marketing
 * app" and "does this business have loyalty?" stay two different, independently
 * true questions — the way `settings-tabs.ts` and `connection-kinds.ts` already
 * keep their concerns separate.
 *
 * Framework-free (no `db`, no `next`) exactly like those two, so the workspace
 * rail, the platform console and any edge code can import it directly.
 */
import type { Industry } from "./industries";
import { hasModule, MODULE_KEYS, type ModuleKey } from "./industry-profile";

export const APP_KEYS = [
  "sales",
  "crm",
  "growth",
  "operations",
  "accounting",
  "connections",
  "settings",
] as const;
export type AppKey = (typeof APP_KEYS)[number];

export interface AppDef {
  key: AppKey;
  label: string;
  /** One line, in the owner's terms, of what this app is for. */
  description: string;
  /**
   * The modules that make up this app. An app is shown only when the
   * business's industry has at least one of them — so a future trade that
   * drops an entire app's worth of modules drops the app with them.
   */
  modules: ModuleKey[];
}

export const APPS: AppDef[] = [
  {
    key: "sales",
    label: "فروش",
    description: "فروش، سفارش‌ها و صندوق — میز کار روزانهٔ کسب‌وکار.",
    // `customers` used to be here. It moved to the CRM app in Phase 36 — see
    // the note on that entry. Selling to a customer still happens here; the
    // customer *record* is the CRM's.
    modules: ["dashboard", "orders", "pos"],
  },
  {
    key: "crm",
    label: "ارتباط با مشتری",
    description:
      "پروندهٔ مشتری، بخش‌بندی، قیف فروش، کارها و پیگیری‌ها، تیکت‌های خدمات و رضایت‌نامهٔ ارتباط.",
    // Phase 36 — the CRM is its own app, not a section of Growth.
    //
    // Phase 35 seated `crm` under Growth as a forward reference, on the
    // reasonable assumption that CRM would be an audience-builder for
    // campaigns. Building it showed the assumption was wrong in a way worth
    // recording: the CRM's subject is the *customer record* — who they are,
    // what they bought, what they asked for, what they agreed to be contacted
    // about — and every other app reads that record. Growth sends to it, the
    // POS creates it, the service desk argues with it, the ledger settles
    // against it. Making the record a folder inside the app that markets to it
    // would put a shared source of truth behind one department's door, and
    // would have left `customers` — a `sales` module — as the only "real" home
    // of a customer while their file, notes, consent and history lived
    // somewhere else.
    //
    // So `customers` moves here with `crm`: one app owns the customer, and
    // /dashboard/customers redirects into it. Growth keeps the engines that
    // *act* on customers (loyalty, promotions, commission) and reads the
    // CRM's segments through `crm-segments-service.ts` rather than owning them.
    modules: ["crm", "customers"],
  },
  {
    key: "growth",
    label: "رشد و بازاریابی",
    description:
      "برنامهٔ نگه‌داشتن و رشد مشتریان: میز کار رشد، وفاداری، کمپین‌ها و کارت هدیه، و پورسانت فروشندگان.",
    // Since Phase 36b this app has a home of its own (/dashboard/growth) with
    // a management dashboard and one section per engine — the same shape the
    // accounting suite has — over the same services and posting rules the
    // three old flat pages used.
    // `website` and `messaging` remain forward references here: both act *on*
    // an audience rather than owning the customer record, so they stay with
    // the engines that will use them. `crm` and `customers` left for the CRM
    // app above — see the note there.
    modules: ["loyalty", "promotions", "commission", "website", "messaging"],
  },
  {
    key: "operations",
    label: "عملیات",
    description:
      "میزها، سالن، آشپزخانه، رزروها، ارسال و انبار — بخش‌های عملیاتی کسب‌وکار.",
    modules: [
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
      "stock",
    ],
  },
  {
    key: "accounting",
    label: "حسابداری",
    description: "دفتر حساب‌ها و گزارش‌های مالی.",
    modules: ["ledger", "reports"],
  },
  {
    key: "connections",
    label: "اتصال‌ها",
    description:
      "اتصال کسب‌وکار به خدمات بیرونی: فروشگاه آنلاین، همگام‌سازی دسکتاپ و دستیارهای هوشمند.",
    modules: ["integrations"],
  },
  {
    key: "settings",
    label: "تنظیمات",
    description: "تنظیمات کسب‌وکار، کاربران، شعب و دستگاه‌ها.",
    modules: ["settings"],
  },
];

/**
 * Module → owning app, built once at load. A module claimed by two apps is a
 * real authoring mistake, not a runtime condition, so it throws on import —
 * the same "fail fast on invalid config" posture `industry-profile.ts` uses
 * for its prefix maps. The assistant (`ai`) and the workspace shell
 * (`workspace`) are intentionally absent: the assistant is the chat *home*,
 * not an app in the rail, and the workspace is the shell around the apps.
 */
const MODULE_APP_MAP: Partial<Record<ModuleKey, AppKey>> = (() => {
  const map: Partial<Record<ModuleKey, AppKey>> = {};
  for (const app of APPS) {
    for (const module of app.modules) {
      const previous = map[module];
      if (previous) {
        throw new Error(
          `Module "${module}" is claimed by both the "${previous}" and "${app.key}" apps`,
        );
      }
      map[module] = app.key;
    }
  }
  return map;
})();

/** Which app owns a module, or null if the module is the home/shell/a future placeholder. */
export function appForModule(module: ModuleKey): AppKey | null {
  return MODULE_APP_MAP[module] ?? null;
}

/** The modules that make up an app. */
export function modulesForApp(app: AppKey): ModuleKey[] {
  return appForKey(app).modules;
}

/** Look up a single app by key. */
export function appForKey(key: AppKey): AppDef {
  const found = APPS.find((candidate) => candidate.key === key);
  // `key` is `AppKey`, so this is exhaustive; the guard is for the impossible path.
  if (!found) throw new Error(`Unknown app key: ${String(key)}`);
  return found;
}

/** Type guard for `AppKey`. */
export function isAppKey(value: string | null | undefined): value is AppKey {
  return typeof value === "string" && (APP_KEYS as readonly string[]).includes(value);
}

export interface AppVisibilityOptions {
  /**
   * The business's industry. Omitted where no business is in hand (the platform
   * console, say); then every app is returned. Apps whose modules the trade
   * does not have are dropped, the same way a module-gated nav entry is.
   */
  industry?: Industry;
}

/**
 * The apps this business sees — those with at least one module its trade has.
 *
 * Note what is *not* here: role, permission and feature-flag checks. Those are
 * applied per *page* by the caller (the rail renders each app's pages through
 * the same `canSee` rule the flat nav used), because an app with, say, only
 * owner-only pages is still an app the manager should see the name of — its
 * pages simply do not list for them. Module presence is the only industry-level
 * question, and it is the only thing decided here.
 */
export function visibleApps(options: AppVisibilityOptions = {}): AppDef[] {
  if (!options.industry) return APPS;
  return APPS.filter((app) => app.modules.some((module) => hasModule(options.industry!, module)));
}

/** Defensive check, mostly for tests: every declared module key is either assigned to an app or intentionally unassigned. */
export function unassignedModules(): ModuleKey[] {
  return MODULE_KEYS.filter((module) => MODULE_APP_MAP[module] === undefined);
}

/**
 * Group arbitrary nav-like items — anything carrying a `module: ModuleKey` — by
 * the app that owns each item's module. This is what turns the flat nav list
 * into the workspace rail: the caller hands in the same `navItems` the flat
 * sidebar used and gets them back as `{ app, items }` pairs, in `APP_KEYS`
 * order, with apps that have no items (or whose modules the trade entirely
 * lacks) dropped.
 *
 * Generic over the item shape so it works for `NavItem` (a client component's
 * type) without this pure module importing a `"use client"` file.
 */
export function appsForNav<T extends { module: ModuleKey }>(
  items: T[],
  industry?: Industry,
): { app: AppDef; items: T[] }[] {
  const byApp = new Map<AppKey, T[]>();
  for (const item of items) {
    const app = appForModule(item.module);
    if (!app) continue;
    const list = byApp.get(app);
    if (list) list.push(item);
    else byApp.set(app, [item]);
  }
  return APPS.filter((def) => {
    if (!byApp.has(def.key)) return false;
    return industry ? def.modules.some((module) => hasModule(industry, module)) : true;
  }).map((def) => ({ app: def, items: byApp.get(def.key)! }));
}
