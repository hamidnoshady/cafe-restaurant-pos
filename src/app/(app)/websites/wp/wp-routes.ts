/**
 * The WordPress & WooCommerce manager's sections.
 *
 * One of the two managers inside «مدیریت وب‌سایت» (the other is the Eshobe CMS
 * site builder). These keys are the one source of truth for what the manager
 * contains; the *URLs* they live at and their active-state rule belong to the
 * app that hosts them, `../website-routes.ts`, so that moving the manager
 * again is one prefix in one file rather than a search across the app. That
 * split is also what keeps the import one-way: this file names the sections,
 * the app's router places them.
 *
 * The manager covers everything a connected store has — commerce (products,
 * orders, customers, categories) and content (posts, pages, media), plus the
 * sync queue. The connection itself is deliberately not a section: every
 * technical connection in the product lives in the «اتصال‌های فنی» hub
 * (/settings/connections), and the old `connections` section redirects there.
 * The read/write operations are shared services in src/lib/integrations/*, so
 * the other apps that need store integration (the POS pushing stock, CRM
 * customers, Growth segments) call the same code this manager's sections
 * call; this is the *management surface*, not the only caller.
 */

import { PERMISSIONS, type Permission } from "@/lib/permissions";

export const WP_SECTION_KEYS = [
  "overview",
  "products",
  "orders",
  "customers",
  "taxonomies",
  "content",
  "media",
  "queue",
] as const;

export type WpSectionKey = (typeof WP_SECTION_KEYS)[number];

/**
 * The capability each WP Manager section needs.
 *
 * Reading the shopfront's state is `website.view`; the sync queue is the one
 * section that exists only to *act* on the live store — retrying and cancelling
 * jobs that push stock and prices outward — so it asks for `website.manage`,
 * the key its own route enforces. Splitting the two means a read-only member
 * sees the store without being handed its controls, instead of being refused
 * the whole manager.
 */
const WP_SECTION_PERMISSION: Record<WpSectionKey, Permission> = {
  overview: PERMISSIONS.websiteView,
  products: PERMISSIONS.websiteView,
  orders: PERMISSIONS.websiteView,
  customers: PERMISSIONS.websiteView,
  taxonomies: PERMISSIONS.websiteView,
  content: PERMISSIONS.websiteView,
  media: PERMISSIONS.websiteView,
  queue: PERMISSIONS.websiteManage,
};

export function canViewWpSection(permissions: ReadonlySet<string>, key: WpSectionKey): boolean {
  return permissions.has(WP_SECTION_PERMISSION[key]);
}
