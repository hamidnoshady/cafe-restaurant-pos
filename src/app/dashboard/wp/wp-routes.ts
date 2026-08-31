/**
 * The WordPress & WooCommerce Manager app's section routing.
 *
 * Same shape as `crm-routes.ts` / `growth-routes.ts`: these keys are the one
 * source of truth for the app's menu (`wp-nav.ts` labels them), for the
 * sidebar's "you are here", and for which section a route renders.
 *
 * The app manages everything a connected store has — commerce (products,
 * orders, customers, categories) and content (posts, pages, media), plus the
 * connection itself. The read/write operations are shared services in
 * src/lib/integrations/*, so the other apps that need store integration (the
 * POS pushing stock, CRM customers, Growth segments) call the same code this
 * app's sections call; this app is the *management surface*, not the only
 * caller.
 */

export const WP_SECTION_KEYS = [
  "overview",
  "connections",
  "products",
  "orders",
  "customers",
  "taxonomies",
  "content",
  "media",
  "queue",
] as const;

export type WpSectionKey = (typeof WP_SECTION_KEYS)[number];

/** The route for a section. The overview is the app root; the rest nest under it. */
export function wpSectionHref(key: WpSectionKey): string {
  return key === "overview" ? "/dashboard/wp" : `/dashboard/wp/${key}`;
}

/**
 * Role gate. Like the integrations panel this app supersedes, everything here
 * is owner/manager work — it writes to a live shopfront and sees every
 * customer record. Cashiers see the launcher but land on the dashboard.
 */
export function canViewWpSection(role: string, _key: WpSectionKey): boolean {
  return ["owner", "manager"].includes(role);
}

/** Whether a dashboard path is a given section — the sidebar's active state. */
export function isWpSectionPathname(pathname: string, key: WpSectionKey): boolean {
  const href = wpSectionHref(key);
  return key === "overview"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}
