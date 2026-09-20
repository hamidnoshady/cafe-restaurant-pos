/**
 * The cross-app data contract.
 *
 * Apps own *systems*, not copies of one another's screens. The owner below is
 * the only app that defines and writes the canonical internal record; the
 * readers use that app's service/API and never create a competing write path.
 * External WordPress data — including the WP-owned connection profile and
 * mapped store mirror — is kept as a mapped integration, so WP Manager owns
 * that system and the WooCommerce/WordPress site remains the remote authority.
 *
 * This is intentionally framework-free. It is a product rule, not a database
 * implementation detail, and can be used by navigation, API guards, the
 * assistant and future sync workers without importing React or `db.ts`.
 */
import type { AppKey } from "./apps";

export const APP_DATA_DOMAINS = [
  "customer_records",
  "sales_documents",
  "ledger_entries",
  "growth_programs",
  "operations_catalogue",
  "wp_store_mirror",
  "website_content",
] as const;

export type AppDataDomain = (typeof APP_DATA_DOMAINS)[number];

export type AppDataSyncStrategy = "shared-service" | "mapped-integration";

export interface AppDataRule {
  domain: AppDataDomain;
  /** The only app allowed to define the canonical internal data for this domain. */
  owner: AppKey;
  /** Apps that may read/use the owner's data through the shared service contract. */
  readers: readonly AppKey[];
  /** How the data crosses the app boundary. */
  syncStrategy: AppDataSyncStrategy;
}

/**
 * One source of truth for cross-app data ownership.
 *
 * A reader does not mean "copy this table into the app". It means that the app
 * may use the data in its own workflow (for example, Growth uses customer
 * records to build an audience and Accounting uses them to attribute A/R).
 */
export const APP_DATA_RULES: readonly AppDataRule[] = [
  {
    domain: "customer_records",
    owner: "crm",
    readers: ["growth", "accounting", "website"],
    syncStrategy: "shared-service",
  },
  {
    domain: "sales_documents",
    owner: "accounting",
    readers: ["growth", "crm", "website"],
    syncStrategy: "shared-service",
  },
  {
    domain: "ledger_entries",
    owner: "accounting",
    readers: ["growth", "crm", "website"],
    syncStrategy: "shared-service",
  },
  {
    domain: "growth_programs",
    owner: "growth",
    readers: ["accounting", "crm"],
    syncStrategy: "shared-service",
  },
  {
    domain: "operations_catalogue",
    owner: "accounting",
    readers: ["website"],
    syncStrategy: "shared-service",
  },
  {
    // The mapped store mirror belongs to «مدیریت وب‌سایت», where the
    // WordPress manager lives: other apps may read the mirror, but no other
    // app owns the store data. The *connection profile* behind the mirror is
    // deliberately not a domain here — every technical connection in the
    // product is owned by the «اتصال‌های فنی» hub, which is shell
    // infrastructure rather than an app, so there is no cross-*app* contract
    // to state for it.
    domain: "wp_store_mirror",
    owner: "website",
    readers: ["accounting", "growth", "crm"],
    syncStrategy: "mapped-integration",
  },
  {
    domain: "website_content",
    owner: "website",
    readers: ["accounting", "growth"],
    syncStrategy: "mapped-integration",
  },
];

const RULE_BY_DOMAIN = new Map(APP_DATA_RULES.map((rule) => [rule.domain, rule]));

/** Return the ownership rule for a data domain. */
export function appDataRule(domain: AppDataDomain): AppDataRule {
  const rule = RULE_BY_DOMAIN.get(domain);
  if (!rule) throw new Error(`Unknown app data domain: ${String(domain)}`);
  return rule;
}

/** Which app owns the canonical record for a data domain? */
export function dataOwner(domain: AppDataDomain): AppKey {
  return appDataRule(domain).owner;
}

/** Whether an app may use a domain, either as its owner or as a reader. */
export function appUsesData(app: AppKey, domain: AppDataDomain): boolean {
  const rule = appDataRule(domain);
  return rule.owner === app || rule.readers.includes(app);
}

/** All apps that may use a domain, with the owner first. */
export function appsUsingData(domain: AppDataDomain): AppKey[] {
  const rule = appDataRule(domain);
  return [rule.owner, ...rule.readers];
}

/** A write to a shared domain is valid only through its owning app's system. */
export function canWriteData(app: AppKey, domain: AppDataDomain): boolean {
  return dataOwner(domain) === app;
}
