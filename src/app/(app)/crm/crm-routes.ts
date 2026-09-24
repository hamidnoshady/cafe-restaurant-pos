/**
 * The CRM app's section routing (Phase 36).
 *
 * Same shape as `growth-routes.ts`, and deliberately so: these keys are the one
 * source of truth for the app's menu (`crm-nav.ts` labels them), for the
 * server-side role gate on each page, and for the sidebar's "you are here".
 * A section that exists as a route but not as a key is a page nobody can find.
 *
 * The role line is drawn differently from Growth's, because the data is
 * different. Growth gates on *compensation*; the CRM gates on **who the
 * customer is**:
 *
 * - `directory`, `persons` (the 360° file) and `activities` are floor work —
 *   a cashier takes a phone number, adds a note, ticks off a callback. They are
 *   the surfaces the old flat «مشتریان» page already gave them.
 * - `cases` is floor work too: the person who hears the complaint is the person
 *   at the counter, and a service desk a cashier cannot open is a service desk
 *   that never gets used.
 * - `leads` is management: an unconverted enquiry carries a revenue
 *   expectation and an owner, and converting one creates a customer record.
 * - `overview`, `segments`, `deals`, `duplicates` and `consent` are management.
 *   Segments and consent decide who gets *messaged*, duplicates *destroys*
 *   records irreversibly, deals carry revenue expectations, and the overview
 *   aggregates all of it — none of that belongs to a shift.
 *
 * Accountants are admitted read-only to nothing here: the CRM holds no ledger
 * data of its own (deals post nothing — see migration 0118), so there is no
 * accounting reason to be in it, and personal customer data with no reason to
 * be read is data that should not be reachable.
 */

export const CRM_SECTION_KEYS = [
  "overview",
  "directory",
  "persons",
  "leads",
  "segments",
  "deals",
  "activities",
  "cases",
  "duplicates",
  // Deciding who an anonymous online shopper is attaches their whole purchase
  // history to a named person, so it sits with the management sections rather
  // than on the floor.
  "reconciliation",
  "consent",
  // The CRM's *own* settings. `/settings` is the platform settings area;
  // `/crm/settings` configures this app (duplicate matching, consent defaults,
  // pipeline stages) and is a different route with a different component.
  "settings",
] as const;

export type CrmSectionKey = (typeof CRM_SECTION_KEYS)[number];

/** The route for a section. The overview is the app root; the rest nest under it. */
export function crmSectionHref(key: CrmSectionKey): string {
  return key === "overview" ? "/crm/overview" : `/crm/${key}`;
}

/** The CRM's own settings page — never the platform settings page. */
export const CRM_SETTINGS_HREF = "/crm/settings";

/** The route of one customer's 360° file. */
export function crmCustomerHref(customerId: string): string {
  return `/crm/persons/${customerId}`;
}

/**
 * Where a won deal's settled sale actually lives. The orders screen opens a
 * given order straight away on `?order=<id>` (see `accounting/orders/page.tsx`
 * and `OrdersList`'s `initialOrderId`) — this is the one other place in the
 * app a deal's `orderId` is allowed to point, since the pipeline itself posts
 * nothing.
 */
export function crmDealOrderHref(orderId: string): string {
  return `/accounting/orders?order=${orderId}`;
}

/**
 * The sections a cashier may open — the floor's share of the app. Kept as one
 * named list rather than inline in the predicate so the reason above and the
 * rule below cannot drift.
 */
const CASHIER_SECTIONS: readonly CrmSectionKey[] = ["directory", "persons", "activities", "cases"];

/** Whether a given role may open a section. */
export function canViewCrmSection(role: string, key: CrmSectionKey): boolean {
  if (role === "cashier") return CASHIER_SECTIONS.includes(key);
  return ["owner", "manager"].includes(role);
}

/** The roles allowed into the app at all — the layout's gate. */
export function canOpenCrm(role: string): boolean {
  return CRM_SECTION_KEYS.some((key) => canViewCrmSection(role, key));
}

/**
 * Where to send someone who lands on a section they may not open. A cashier
 * following a bookmark to the pipeline gets the directory rather than being
 * thrown out of the app entirely — being bounced to `/dashboard` from a page
 * you were linked to reads as a bug, not as a permission.
 */
export function crmFallbackHref(role: string): string {
  return canViewCrmSection(role, "directory") ? crmSectionHref("directory") : "/dashboard";
}

/**
 * Whether a dashboard path is a given section — the sidebar's idea of "you are
 * here". The overview is the app root, so it matches exactly and nothing else;
 * every other section also owns what nests under it. A customer's file
 * (`/crm/persons/<id>`) belongs to Contacts (`directory`) for navigation, not
 * to a permanent detail-page sidebar entry.
 *
 * The old `customers` path is kept as an alias for `persons` so bookmarks and
 * external links survive the rename — both the current `/crm/customers/*` and
 * the pre-move `/dashboard/crm/customers/*`, which middleware redirects here.
 */
export function isCrmSectionPathname(pathname: string, key: CrmSectionKey): boolean {
  const href = crmSectionHref(key);
  if (key === "overview") return pathname === href;
  const isPersonDetail =
    pathname === "/crm/persons" ||
    pathname.startsWith("/crm/persons/") ||
    pathname === "/crm/customers" ||
    pathname.startsWith("/crm/customers/");
  // A person file is reached from Contacts; it is not a second permanent
  // sidebar destination. Keep the owning Contacts row current on both the
  // canonical and compatibility detail URLs.
  if (key === "directory") {
    return pathname === href || pathname.startsWith(`${href}/`) || isPersonDetail;
  }
  if (key === "persons") return isPersonDetail;
  return pathname === href || pathname.startsWith(`${href}/`);
}
