/**
 * The four standalone business apps. Modules are trade capabilities and work
 * areas, not apps in their own right. Accounting owns selling and operations;
 * Growth, CRM and Website own their own workspaces. Website contains separate
 * Eshobe CMS and WordPress/Woo managers within one app.
 *
 * The assistant, workspace, settings and connections are shared
 * platform utilities; they do not have their own app availability state.
 */
import type { Industry } from "./industries";
import { hasModule, MODULE_KEYS, type ModuleKey } from "./industry-profile";

export const APP_KEYS = [
  "accounting",
  "growth",
  "crm",
  "website",
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
    key: "accounting",
    label: "حسابداری",
    description: "فروش و صندوق، سفارش‌ها، عملیات، خرید و انبار، دفتر حساب‌ها و گزارش‌ها.",
    // Sales/POS and operations are work areas inside Accounting's workspace.
    // The operational dashboard follows Accounting; shared settings do not.
    modules: [
      "dashboard", "orders", "pos", "tables", "waiter", "kitchen", "reservations",
      "delivery", "inventory", "menu", "jewelry", "watch", "accessories",
      "cosmetics", "wholesale", "tools_fittings", "haberdashery", "stock",
      "ledger", "reports",
    ],
  },
  {
    key: "growth",
    label: "رشد و بازاریابی",
    description:
      "برنامهٔ نگه‌داشتن و رشد مشتریان: میز کار رشد، وفاداری، کمپین‌ها و کارت هدیه، و پورسانت فروشندگان.",
    // Since Phase 36b this app has a home of its own (/growth) with
    // a management dashboard and one section per engine — the same shape the
    // accounting suite has — over the same services and posting rules the
    // three old flat pages used.
    // `messaging` remains a forward reference here: it acts *on* an audience
    // rather than owning the customer record, so it stays with the engines
    // that will use it. `crm` and `customers` left for the CRM app above —
    // see the note there. `website` left too, below — see its own note.
    modules: ["loyalty", "promotions", "commission", "messaging"],
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
    // would have left `customers` — formerly a Sales module — as the only "real" home
    // of a customer while their file, notes, consent and history lived
    // somewhere else.
    //
    // So `customers` lives here with `crm`: one app owns the customer, and
    // /dashboard/customers redirects into it. Growth keeps the engines that
    // *act* on customers (loyalty, promotions, commission) and reads the
    // CRM's segments through `crm-segments-service.ts` rather than owning them.
    modules: ["crm", "customers"],
  },
  {
    key: "website",
    label: "مدیریت وب‌سایت",
    description:
      "مدیریت خودِ سایت‌ها، از هر دو راه: سایت‌ساز اشوبه (Eshobe CMS) و وردپرس و ووکامرس — هرکدام بخش مدیریت جدای خودش را دارد. اتصال فنی هر دو در «اتصال‌های فنی» است.",
    // One app, two managers — and it is *one* app on purpose.
    //
    // Until now these were two peers in the rail: «وب‌سایت» (the eshobe-cms
    // connection, issue #378) and «مدیریت وردپرس و ووکامرس» (Phase 40). From
    // the rail that reads as two products for one question — "where does my
    // website live?" — and a business that runs a WordPress shop today and
    // moves to the platform site tomorrow had to learn a second app to do the
    // same job. So the app is «مدیریت وب‌سایت» and the two systems are its two
    // *managers*: /dashboard/website/cms and /dashboard/website/wp, each with
    // its own sections and its own settings. They are never folded into each
    // other — that is the rule CLAUDE.md's prompt vocabulary states — they
    // are peers inside one door.
    //
    // The app manages the sites themselves — content, products, orders,
    // sync preferences. The *technical connection* behind each manager (the
    // CMS credential, the WooCommerce/WordPress link) is not a section here:
    // every technical connection in the product lives in the «اتصال‌های فنی»
    // hub (/settings/connections), which is deliberately not an app, and any
    // connection surface anywhere else redirects to it.
    //
    // Both modules therefore belong here: `website` gates the CMS half
    // (docs/eshobe-cms-integration.md) and `integrations` the WordPress half.
    // `apps.ts` is only grouping; `industry-profile.ts` still answers whether
    // a trade has either module, so a trade with just one of them opens the
    // app and sees just that manager.
    modules: ["website", "integrations"],
  },
];

// NOTE — there is deliberately no "connections" app. «اتصال‌های فنی»
// (/settings/connections) is the one hub for every technical connection in
// the product — desktop pairing, WordPress/WooCommerce, the Eshobe CMS site,
// Holoo, the remote server sync, MCP and API keys — but it is a technical
// utility of the shell, not a سکو: it is never listed in the platform
// switchboard, never badged, and never gated by app availability. Its module
// (`connections`) stays intentionally unassigned below, next to `ai` and
// `workspace`, so `appForModule` answers null for it and every guard fails
// open. Each tab still carries its own role and feature gate
// (src/lib/connection-kinds.ts).

/**
 * Module → owning app, built once at load. A module claimed by two apps is a
 * real authoring mistake, not a runtime condition, so it throws on import —
 * the same "fail fast on invalid config" posture `industry-profile.ts` uses
 * for its prefix maps. The assistant (`ai`), workspace (`workspace`), shared settings (`settings`)
 * and technical-connections hub (`connections`) are
 * intentionally absent: the assistant is the chat *home*, not an app in the
 * rail, the workspace is the shell around the apps, and shared utilities are shell
 * infrastructure — see the NOTE above.
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

/**
 * Which app owns a module, or null if it is a shared utility, a future
 * placeholder, or the technical-connections hub (`connections` — see the note
 * above: the hub is shell infrastructure, not an app, so it has no availability
 * state and no guard ever blocks it).
 */
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
